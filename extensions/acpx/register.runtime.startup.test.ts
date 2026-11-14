import path from "node:path";
import { setImmediate } from "node:timers/promises";
import {
  getAcpRuntimeBackend,
  requireAcpRuntimeBackend,
} from "openclaw/plugin-sdk/acp-runtime-backend";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import { resolvePreferredOpenClawTmpDir, tempWorkspace } from "openclaw/plugin-sdk/temp-path";
import { afterEach, expect, it, vi } from "vitest";
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

it.each([true, false])("gates concurrent spawns on startup health (%s)", async (healthy) => {
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
    const settled = vi.fn();
    const admissions = Promise.allSettled(Array.from({ length: 8 }, (_, i) => admit(`child-${i}`)));
    void admissions.then(settled);
    await setImmediate();
    expect(settled).not.toHaveBeenCalled();
    expect(ensureSession).not.toHaveBeenCalled();
    release.resolve(healthy);
    const results = [await first, ...(await admissions)];
    expect(probe).toHaveBeenCalledOnce();
    if (healthy) {
      expect(results.map((result) => result.status)).toEqual(Array(9).fill("fulfilled"));
      expect(ensureSession).toHaveBeenCalledTimes(9);
    } else {
      const unavailable = { code: "ACP_BACKEND_UNAVAILABLE" };
      for (const result of results) {
        expect(result).toMatchObject({ status: "rejected", reason: unavailable });
      }
      expect(ensureSession).not.toHaveBeenCalled();
      await expect(admit("failed-steady-state")).rejects.toMatchObject(unavailable);
      // Doctor bypasses the admission health guard so operators can recover the backend.
      await getAcpRuntimeBackend("acpx")!.runtime.doctor!();
      await expect(admit("recovered")).resolves.toMatchObject({ backend: "acpx" });
      expect(probe).toHaveBeenCalledTimes(2);
    }
  } finally {
    release.resolve(false);
    await first;
    await service.stop?.(ctx);
    await workspace.cleanup();
  }
});
