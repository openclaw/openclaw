import type { CreateReservedSandboxBackendParamsV1 } from "openclaw/plugin-sdk/sandbox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBackend, createManager } from "./backend.js";
import { GuestOwner, type GuestJournal, type GuestRecord } from "./guest.js";
import type { Invoke } from "./native.js";

vi.mock("./filesystem.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./filesystem.js")>()),
  validateRootfs: async () => "/opt/guest",
  resolveMounts: async () => [
    { hostPath: "/host/work", containerPath: "/workspace", readOnly: false },
  ],
}));
const config = { rootfs: "/opt/guest", allowEgress: false, guestLifetimeSeconds: 60 };
const success = () => ({ code: 0, stdout: Buffer.from("/workspace\n"), stderr: Buffer.alloc(0) });
async function fixture(run: Invoke = async () => success()) {
  vi.stubGlobal("process", { ...process, platform: "linux", getuid: () => 0 });
  const rows = new Map<string, GuestRecord>();
  const journal: GuestJournal = {
    register: async (key, value, options) => {
      options?.assertCurrent?.();
      rows.set(key, structuredClone(value));
    },
    delete: async (key) => rows.delete(key),
    entries: async () =>
      [...rows].map(([key, value]) => ({ key, value, createdAt: 0, updatedAt: 0 })),
  };
  let current = true;
  const params = {
    runtimeId: "oc-cr-00000000-0000-4000-8000-000000000001",
    sessionKey: "test",
    scopeKey: "test",
    workspaceDir: "/host/work",
    agentWorkspaceDir: "/host/agent",
    assertRuntimeCurrent: () => {
      if (!current) {
        throw new Error("revoked");
      }
    },
    cfg: { backend: "cloud-run-sandbox", workspaceAccess: "none", docker: { env: {} } },
  } as CreateReservedSandboxBackendParamsV1;
  const owner = new GuestOwner(journal, run);
  return {
    backend: await createBackend(params, config, owner, "/state"),
    owner,
    rows,
    revoke: () => {
      current = false;
    },
  };
}
afterEach(() => vi.unstubAllGlobals());
describe("Cloud Run backend", () => {
  it("stages environment on stdin, not in launch argv or host env", async () => {
    const run = vi.fn<Invoke>(async () => success());
    const { backend, rows } = await fixture(run);
    const cleanup = backend.prepareProcessCleanup!({ TOP_SECRET: "synthetic-secret" });
    const spec = await backend.buildExecSpec({
      command: "echo ok",
      env: cleanup.env,
      usePty: false,
    });
    expect(JSON.stringify(spec.argv)).not.toContain("synthetic-secret");
    expect(JSON.stringify(spec.env)).not.toContain("synthetic-secret");
    expect(run.mock.calls[1]?.[1]?.stdin).toContain("synthetic-secret");
    await backend.finalizeExec!({
      status: "completed",
      exitCode: 0,
      timedOut: false,
      token: spec.finalizeToken,
    });
    expect(rows.size).toBe(0);
    expect(() => spec.assertCurrent?.()).toThrow("ended");
  });
  it("cleanup can delete a prepared guest after revocation", async () => {
    const run = vi.fn<Invoke>(async () => success());
    const { backend, revoke, rows } = await fixture(run);
    const cleanup = backend.prepareProcessCleanup!({});
    const spec = await backend.buildExecSpec({
      command: "echo ok",
      env: cleanup.env,
      usePty: false,
    });
    revoke();
    expect(() => spec.assertCurrent?.()).toThrow("revoked");
    await cleanup.terminate();
    await backend.finalizeExec!({
      status: "failed",
      exitCode: null,
      timedOut: true,
      token: spec.finalizeToken,
    });
    expect(rows.size).toBe(0);
    expect(run.mock.calls.at(-1)?.[0][0]).toBe("delete");
  });
  it("does not allocate for pre-aborted shell commands", async () => {
    const run = vi.fn<Invoke>(async () => success());
    const { backend } = await fixture(run);
    const controller = new AbortController();
    controller.abort();
    await expect(
      backend.runShellCommand({ script: "touch /workspace/no", signal: controller.signal }),
    ).rejects.toThrow();
    expect(run).not.toHaveBeenCalled();
  });
  it("deletes the guest on active shell cancellation before settling", async () => {
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const run = vi.fn<Invoke>(async (args, options) => {
      if (args[0] !== "exec") {
        return success();
      }
      started();
      return await new Promise((_resolve, reject) => {
        options?.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
          once: true,
        });
      });
    });
    const { backend, rows } = await fixture(run);
    const controller = new AbortController();
    const result = backend
      .runShellCommand({ script: "sleep 10", signal: controller.signal })
      .catch((error: unknown) => error);
    await ready;
    controller.abort();
    expect(await result).toBeInstanceOf(Error);
    expect(run.mock.calls.at(-1)?.[0][0]).toBe("delete");
    expect(rows.size).toBe(0);
  });
  it("rejects lexical workdir escapes without launching", async () => {
    const run = vi.fn<Invoke>(async () => success());
    const { backend } = await fixture(run);
    expect(await backend.validateWorkdir!("/etc")).toBeNull();
    expect(await backend.validateWorkdir!("/workspace/../etc")).toBeNull();
    await expect(
      backend.buildExecSpec({ command: "id", workdir: "/etc", env: {}, usePty: false }),
    ).rejects.toThrow("workdir");
    expect(run).not.toHaveBeenCalled();
  });
  it("rejects invalid environment names before allocation", async () => {
    const run = vi.fn<Invoke>(async () => success());
    const { backend } = await fixture(run);
    await expect(
      backend.buildExecSpec({ command: "id", env: { "BAD;name": "value" }, usePty: false }),
    ).rejects.toThrow("environment");
    expect(run).not.toHaveBeenCalled();
  });
  it("refuses unsupported guest PTYs before allocation", async () => {
    const run = vi.fn<Invoke>(async () => success());
    const { backend } = await fixture(run);
    await expect(backend.buildExecSpec({ command: "id", env: {}, usePty: true })).rejects.toThrow(
      "PTY",
    );
    expect(run).not.toHaveBeenCalled();
  });
  it("never executes guest-controlled binaries merely to inspect runtime status", async () => {
    const run = vi.fn<Invoke>(async () => success());
    const { backend, owner, rows } = await fixture(run);
    const guestId = "oc-exec-00000000-0000-4000-8000-000000000002";
    rows.set(guestId, { runtimeId: backend.runtimeId, guestId, phase: "ready" });
    await expect(
      createManager(owner, config).describeRuntime({
        entry: {
          containerName: backend.runtimeId,
          backendId: backend.id,
          sessionKey: "test",
          createdAtMs: 0,
          lastUsedAtMs: 0,
          image: config.rootfs,
        },
        config: {},
      }),
    ).rejects.toThrow("read-only runtime status");
    expect(run).not.toHaveBeenCalled();
  });
});
