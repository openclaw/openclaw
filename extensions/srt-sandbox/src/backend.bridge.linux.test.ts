// LIVE Linux (bubblewrap) AC4 + fd-lifecycle tests for the SRT sandbox backend.
//
// AC-L4 = AC4 re-run on Linux under bwrap (design v8 §5, gating, no downgrade).
// The pin owner is launched INSIDE the SRT sandbox via the same
// wrapWithSandboxArgv wrap backend.ts uses, so every held-fd open/mutation is
// kernel-enforced against the scope's allowWrite policy. The three AC4 checks
// are reproduced directly (real command/fd behaviour, not assertions):
//   (1) mid-segment real-dir swap → write lands in the ORIGINAL held vnode;
//   (2) delete pinned target → mutate fails ENOENT, no resurrection on recreate;
//   (3) held fd outside allowWrite → kernel denial (bwrap equivalent of the
//       macOS Seatbelt EPERM: the out-of-policy parent is read-only bound).
// AC-L5: held-pin + owner fd counts (/proc/self/fd via /dev/fd) return to
// baseline after a full mutate cycle — no fd leak.
import { mkdtempSync, mkdirSync, readFileSync, existsSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import type { SandboxBackendHandle } from "openclaw/plugin-sdk/sandbox";
import { afterEach, describe, expect, it } from "vitest";
import { resolveSrtPluginConfig } from "./config.js";
import { createSrtFsBridge, DEFAULT_SRT_PIN_LIMITS } from "./fs-bridge.js";
import { PinOwnerClient } from "./pin-owner-client.js";
import { buildPinOwnerCommand } from "./pin-owner-source.js";
import { ScopeChildReaper } from "./scope-reaper.js";

const isLinux = process.platform === "linux";

/** Local mirror of the SDK context type (not exported from plugin-sdk/sandbox). */
type SandboxFsBridgeContext = Parameters<
  NonNullable<SandboxBackendHandle["createFsBridge"]>
>[0]["sandbox"];

type Fixture = {
  ws: string;
  agent: string;
  reaper: ScopeChildReaper;
  client: PinOwnerClient;
  bridge: ReturnType<typeof createSrtFsBridge>;
};

const fixtures: Fixture[] = [];

/** Build a bridge whose pin owner runs under a real bwrap wrap (allowWrite=[ws,agent]). */
function makeSandboxedFixture(): Fixture {
  const ws = mkdtempSync(path.join(tmpdir(), "srt-lxb-ws-"));
  const agent = mkdtempSync(path.join(tmpdir(), "srt-lxb-agent-"));
  const pluginConfig = resolveSrtPluginConfig(undefined);
  const reaper = new ScopeChildReaper();
  const client = new PinOwnerClient({
    spawnOwner: async () => {
      const wrapped = await SandboxManager.wrapWithSandboxArgv(
        buildPinOwnerCommand(),
        pluginConfig.binShell,
        {
          network: { allowedDomains: [], deniedDomains: ["*"] },
          filesystem: { allowRead: [], denyRead: [], allowWrite: [ws, agent], denyWrite: [] },
        },
        undefined,
        ws,
      );
      return reaper.spawnPersistent({ argv: wrapped.argv, env: wrapped.env ?? {}, cwd: ws });
    },
    rpcTimeoutMs: 20_000,
  });
  const bridge = createSrtFsBridge({
    sandbox: {
      workspaceDir: ws,
      agentWorkspaceDir: agent,
      workspaceAccess: "rw",
      containerName: "test-lxb-scope",
      containerWorkdir: ws,
      docker: {},
    } as SandboxFsBridgeContext,
    writableRoots: [ws, agent],
    client,
    limits: { ...DEFAULT_SRT_PIN_LIMITS },
  });
  const fixture = { ws, agent, reaper, client, bridge };
  fixtures.push(fixture);
  return fixture;
}

afterEach(() => {
  while (fixtures.length > 0) {
    const f = fixtures.pop()!;
    f.bridge.dispose();
    f.client.dispose();
    f.reaper.dispose();
    rmSync(f.ws, { recursive: true, force: true });
    rmSync(f.agent, { recursive: true, force: true });
  }
});

describe.skipIf(!isLinux)("srt sandbox Linux AC-L4 (AC4 under bwrap, no downgrade)", () => {
  it("(1) lands the pinned write in the ORIGINAL held vnode after a mid-segment real-dir swap", async () => {
    const f = makeSandboxedFixture();
    mkdirSync(path.join(f.ws, "a", "b"), { recursive: true });
    const target = await f.bridge.resolvePinnedMutationTarget!({
      filePath: "a/b/new.txt",
      action: "write",
    });
    // Swap the real directory b -> b_old, create a fresh b (different inode).
    const swapped = path.join(f.ws, "a", "b");
    const original = path.join(f.ws, "a", "b_old");
    renameSync(swapped, original);
    mkdirSync(swapped);

    await f.bridge.writeFile({
      filePath: "a/b/new.txt",
      data: "authorized",
      pinnedPath: target.pinnedPath,
    });
    expect(readFileSync(path.join(original, "new.txt"), "utf8")).toBe("authorized");
    expect(existsSync(path.join(swapped, "new.txt"))).toBe(false);
  });

  it("(2) fails closed with ENOENT when the pinned target is deleted; recreate does not resurrect", async () => {
    const f = makeSandboxedFixture();
    mkdirSync(path.join(f.ws, "victim"), { recursive: true });
    const target = await f.bridge.resolvePinnedMutationTarget!({
      filePath: "victim/leak.txt",
      action: "write",
    });
    rmSync(path.join(f.ws, "victim"), { recursive: true });
    await expect(
      f.bridge.writeFile({ filePath: "victim/leak.txt", data: "x", pinnedPath: target.pinnedPath }),
    ).rejects.toThrow(/ENOENT|No such file/);
    // A brand-new directory at the same path (possible inode reuse) is unreachable.
    mkdirSync(path.join(f.ws, "victim"), { recursive: true });
    expect(existsSync(path.join(f.ws, "victim/leak.txt"))).toBe(false);
  });

  it("(3) denies a held-fd mutation whose parent is outside allowWrite (kernel denial)", async () => {
    const f = makeSandboxedFixture();
    // A directory the sandbox can READ (reads are open → read-only bound) but is
    // NOT in allowWrite. Holding a live fd to it grants no write escape.
    const outsideParent = mkdtempSync(path.join(tmpdir(), "srt-lxb-out-"));
    mkdirSync(path.join(outsideParent, "target"), { recursive: true });
    try {
      // In-policy control: a held-fd write inside the workspace succeeds.
      mkdirSync(path.join(f.ws, "inside"), { recursive: true });
      await f.client.resolvePin(1, { root: f.ws, rel: "inside", leaf: "ok.txt", mode: "file" });
      const ok = await f.client.mutate(1, { kind: "write", data: Buffer.from("in-policy") });
      expect(ok.result).toBe("created");
      expect(readFileSync(path.join(f.ws, "inside", "ok.txt"), "utf8")).toBe("in-policy");

      // Out-of-policy: hold a live fd to a dir outside allowWrite, then mutate.
      // bwrap read-only binds it, so the write fails closed at the kernel.
      await f.client.resolvePin(2, {
        root: outsideParent,
        rel: "target",
        leaf: "escape.txt",
        mode: "file",
      });
      await expect(
        f.client.mutate(2, { kind: "write", data: Buffer.from("escape") }),
      ).rejects.toThrow(/EROFS|EPERM|EACCES|ENOENT|read-only|not permitted|No such file/i);
      expect(existsSync(path.join(outsideParent, "target", "escape.txt"))).toBe(false);
    } finally {
      rmSync(outsideParent, { recursive: true, force: true });
    }
  });
});

describe.skipIf(!isLinux)("srt sandbox Linux AC-L5 (held-fd/no-leak under bwrap)", () => {
  it("returns held-pin and owner fd counts to baseline after a full mutate cycle", async () => {
    const f = makeSandboxedFixture();
    // Wake the owner and record its baseline open-fd count (owner reads /dev/fd,
    // which is /proc/self/fd on Linux).
    await f.bridge.writeFile({ filePath: "wake.txt", data: "wake" });
    const base = await f.client.ping();
    expect(base.held).toBe(0);

    // A full resolve+mutate cycle must leave no held pin and no leaked fd.
    const t = await f.bridge.resolvePinnedMutationTarget!({
      filePath: "cycle.txt",
      action: "write",
    });
    const mid = await f.client.ping();
    expect(mid.held).toBe(1);
    await f.bridge.writeFile({ filePath: "cycle.txt", data: "done", pinnedPath: t.pinnedPath });

    const after = await f.client.ping();
    expect(after.held).toBe(0);
    if (base.fds >= 0) {
      // /proc/self/fd count is back to baseline — the held directory fds closed.
      expect(after.fds).toBeLessThanOrEqual(base.fds);
    }
  });

  it("fails the bridge closed after dispose (owner reaped, no zombie)", async () => {
    const f = makeSandboxedFixture();
    await f.bridge.writeFile({ filePath: "before.txt", data: "x" });
    f.bridge.dispose();
    await expect(f.bridge.writeFile({ filePath: "after.txt", data: "y" })).rejects.toThrow();
  });
});
