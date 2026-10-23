import path from "node:path";
import {
  getAcpRuntimeBackend,
  requireAcpRuntimeBackend,
} from "openclaw/plugin-sdk/acp-runtime-backend";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import { resolvePreferredOpenClawTmpDir, tempWorkspace } from "openclaw/plugin-sdk/temp-path";
import { afterEach, expect, it, vi, type MockInstance } from "vitest";
import { createRegisteredAcpxService } from "./registration.test-support.js";
import type { OpenClawPluginServiceContext } from "./runtime-api.js";
import { createEmptyAcpxKeyedStore } from "./src/empty-keyed-store.test-support.js";
import * as acpxRuntime from "./src/runtime.js";
import { makeEmptySessionStore, makeRuntime } from "./src/runtime.test-support.js";

// mock-isolation: auth-file preparation is unrelated to startup admission and must not read host credentials.
vi.mock("./src/codex-auth-bridge.js", () => ({
  prepareAcpxCodexAuthConfig: async ({ pluginConfig }: { pluginConfig: unknown }) => pluginConfig,
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

async function withStartingBackend(
  run: (fixture: {
    admit: (name: string) => Promise<unknown>;
    probe: ReturnType<typeof makeRuntime>["probe"];
    ensureSession: MockInstance<ReturnType<typeof makeRuntime>["runtime"]["ensureSession"]>;
    first: Promise<PromiseSettledResult<unknown>>;
    releaseProbe: (ok: boolean) => void;
  }) => Promise<void>,
) {
  const workspace = await tempWorkspace({
    rootDir: resolvePreferredOpenClawTmpDir(),
    prefix: "openclaw-acpx-startup-",
  });
  const ctx: OpenClawPluginServiceContext = {
    workspaceDir: workspace.dir,
    stateDir: path.join(workspace.dir, "state"),
    config: { acp: { allowedAgents: ["claude"] } },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  };
  const { runtime, probe } = makeRuntime(makeEmptySessionStore());
  const ensureSession = vi.spyOn(runtime, "ensureSession").mockImplementation(async (input) => ({
    sessionKey: input.sessionKey,
    backend: "acpx",
    runtimeSessionName: input.sessionKey,
  }));
  const entered = createDeferred<void>();
  const release = createDeferred<boolean>();
  probe.mockImplementationOnce(async () => {
    entered.resolve();
    return { ok: await release.promise, message: "synthetic startup probe" };
  });
  vi.stubEnv("OPENCLAW_SKIP_ACPX_RUNTIME", undefined);
  vi.stubEnv("OPENCLAW_SKIP_ACPX_RUNTIME_PROBE", undefined);
  vi.stubEnv("OPENCLAW_ACPX_RUNTIME_STARTUP_PROBE", "1");
  vi.spyOn(acpxRuntime, "AcpxRuntime").mockImplementation(function () {
    return runtime;
  });
  const service = createRegisteredAcpxService({
    runtime: createPluginRuntimeMock({ state: { openKeyedStoreV2: createEmptyAcpxKeyedStore } }),
  });
  const admit = async (name: string) =>
    requireAcpRuntimeBackend("acpx").runtime.ensureSession({
      sessionKey: `agent:main:acp:${name}`,
      agent: "claude",
      mode: "persistent",
    });
  await service.start(ctx);
  const first = Promise.allSettled([admit("first")]).then(([result]) => result!);
  try {
    await entered.promise;
    await run({ admit, probe, ensureSession, first, releaseProbe: release.resolve });
  } finally {
    release.resolve(false);
    await first;
    await service.stop?.(ctx);
    await workspace.cleanup();
  }
}

it("admits concurrent first spawns through the registry while the acpx startup probe is pending", async () => {
  await withStartingBackend(async ({ admit, probe, ensureSession, first, releaseProbe }) => {
    let settled = false;
    const admissions = Promise.allSettled(
      Array.from({ length: 8 }, (_, i) => admit(`child-${i}`)),
    ).then((results) => {
      settled = true;
      return results;
    });
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(settled).toBe(false);
    expect(ensureSession).not.toHaveBeenCalled();
    releaseProbe(true);
    expect((await admissions).map((result) => result.status)).toEqual(Array(8).fill("fulfilled"));
    expect((await first).status).toBe("fulfilled");
    expect(ensureSession).toHaveBeenCalledTimes(9);
    expect(probe).toHaveBeenCalledOnce();
  });
});

it("rejects waiting spawns after a failed probe, fails fast afterward, and allows doctor recovery", async () => {
  await withStartingBackend(async ({ admit, probe, ensureSession, first, releaseProbe }) => {
    const admissions = Promise.allSettled(Array.from({ length: 8 }, (_, i) => admit(`child-${i}`)));
    releaseProbe(false);
    for (const result of [await first, ...(await admissions)]) {
      expect(result).toMatchObject({
        status: "rejected",
        reason: { code: "ACP_BACKEND_UNAVAILABLE" },
      });
    }
    expect(ensureSession).not.toHaveBeenCalled();
    await expect(admit("failed-steady-state")).rejects.toMatchObject({
      code: "ACP_BACKEND_UNAVAILABLE",
    });
    expect(probe).toHaveBeenCalledOnce();
    // Doctor bypasses the admission health guard so operators can recover the backend.
    await getAcpRuntimeBackend("acpx")!.runtime.doctor!();
    await expect(admit("recovered")).resolves.toMatchObject({ backend: "acpx" });
    expect(probe).toHaveBeenCalledTimes(2);
  });
});
