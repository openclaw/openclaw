// Host runtime authority across POSIX factory provisioning.
//
// The host may revoke assertRuntimeCurrent while the factory is still awaiting
// dependency discovery or SRT initialization. The factory must then reject with
// the host's own error and release the runtime lease itself: the caller's
// registry drops a rejected handle without disposing it. Discovery and
// initialization are paused on deferred promises so each revocation lands at an
// exact point; the backend-owned runtime coordinator runs unmocked.
import type { SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import type { CreateSandboxBackendParams } from "openclaw/plugin-sdk/sandbox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createSrtSandboxBackendFactory,
  createSrtSandboxBackendManager,
  shutdownSrtSandboxRuntime,
  SRT_SANDBOX_BACKEND_ID,
} from "./backend.js";
import { resolveSrtPluginConfig } from "./config.js";
import { assertSrtSandboxAvailable } from "./dependency-probe.js";

const PROXY_PORT = 43123;

const srt = vi.hoisted(() => ({
  config: undefined as SandboxRuntimeConfig | undefined,
  proxyPort: undefined as number | undefined,
  initialize: vi.fn<(config: SandboxRuntimeConfig) => Promise<void>>(),
  reset: vi.fn<() => Promise<void>>(),
}));

vi.mock("@anthropic-ai/sandbox-runtime", async (importActual) => {
  const actual = await importActual<typeof import("@anthropic-ai/sandbox-runtime")>();
  return {
    ...actual,
    SandboxManager: {
      ...actual.SandboxManager,
      initialize: srt.initialize,
      reset: srt.reset,
      isSandboxingEnabled: () => srt.config !== undefined,
      getConfig: () => srt.config,
      getProxyPort: () => srt.proxyPort,
    },
  };
});

vi.mock("./dependency-probe.js", async (importActual) => ({
  ...(await importActual<typeof import("./dependency-probe.js")>()),
  assertSrtSandboxAvailable: vi.fn().mockResolvedValue(undefined),
}));

type Authority = {
  current: boolean;
  revoked: Error;
  assertRuntimeCurrent: () => void;
};

function makeAuthority(): Authority {
  const authority: Authority = {
    current: true,
    revoked: new Error("runtime authority revoked by host"),
    assertRuntimeCurrent: () => {
      if (!authority.current) {
        throw authority.revoked;
      }
    },
  };
  return authority;
}

function makeParams(scopeKey: string, authority: Authority): CreateSandboxBackendParams {
  return {
    sessionKey: scopeKey,
    scopeKey,
    workspaceDir: "/tmp/srt-factory-authority",
    agentWorkspaceDir: "/tmp/srt-factory-authority-agent",
    cfg: {
      mode: "all",
      backend: SRT_SANDBOX_BACKEND_ID,
      scope: "session",
      workspaceAccess: "rw",
      workspaceRoot: "/tmp/srt-factory-authority",
      dockerTmpfsSource: "default",
      docker: { workdir: "/tmp/srt-factory-authority", env: {} },
      ssh: {},
      browser: {},
      tools: {},
      prune: {},
    } as unknown as CreateSandboxBackendParams["cfg"],
    assertRuntimeCurrent: authority.assertRuntimeCurrent,
  };
}

async function removeScope(scopeKey: string): Promise<void> {
  const manager = createSrtSandboxBackendManager();
  await manager.removeRuntime({
    entry: { containerName: scopeKey },
  } as Parameters<NonNullable<typeof manager.removeRuntime>>[0]);
}

/** Wait for a pause point, failing fast if the factory settles before it. */
async function reached(pausePoint: Promise<void>, pending: Promise<unknown>): Promise<void> {
  await Promise.race([
    pausePoint,
    pending.then(() => {
      throw new Error("factory settled before the pause point");
    }),
  ]);
}

/** Pause the next dependency discovery until released. */
function pauseDiscovery() {
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  vi.mocked(assertSrtSandboxAvailable).mockImplementationOnce(async () => {
    started.resolve();
    await release.promise;
  });
  return { started: started.promise, release: () => release.resolve() };
}

/** Pause the next SRT initialization until released; it then succeeds. */
function pauseInitialization() {
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  srt.initialize.mockImplementationOnce(async (config) => {
    started.resolve();
    await release.promise;
    srt.config = config;
    srt.proxyPort = PROXY_PORT;
  });
  return { started: started.promise, release: () => release.resolve() };
}

beforeEach(() => {
  srt.config = undefined;
  srt.proxyPort = undefined;
  srt.initialize.mockReset().mockImplementation(async (config) => {
    srt.config = config;
    srt.proxyPort = PROXY_PORT;
  });
  srt.reset.mockReset().mockImplementation(async () => {
    srt.config = undefined;
    srt.proxyPort = undefined;
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await shutdownSrtSandboxRuntime();
  srt.config = undefined;
  srt.proxyPort = undefined;
});

// Broker mode creates its session broker lazily, so it provisions through the
// same POSIX factory path; run every case under both configurations.
describe.skipIf(process.platform === "win32").each([
  { mode: "ordinary", perSessionNetwork: false },
  { mode: "per-session broker", perSessionNetwork: true },
])("srt factory provisioning authority ($mode)", ({ perSessionNetwork }) => {
  let factory: ReturnType<typeof createSrtSandboxBackendFactory>;

  beforeEach(() => {
    factory = createSrtSandboxBackendFactory({
      pluginConfig: resolveSrtPluginConfig({ network: "deny", perSessionNetwork }),
    });
  });

  /** Revoke while initialization is awaited, then let it complete successfully. */
  async function revokeDuringInitialization(scopeKey: string, authority: Authority) {
    const initialization = pauseInitialization();
    const pending = factory(makeParams(scopeKey, authority));
    await reached(initialization.started, pending);
    authority.current = false;
    initialization.release();
    return pending;
  }

  it("rejects with the host's error when revoked during dependency discovery", async () => {
    const authority = makeAuthority();
    const discovery = pauseDiscovery();
    const pending = factory(makeParams("revoked-discovery", authority));
    await reached(discovery.started, pending);
    authority.current = false;
    discovery.release();

    await expect(pending).rejects.toBe(authority.revoked);
    expect(srt.initialize).not.toHaveBeenCalled();
    expect(srt.reset).not.toHaveBeenCalled();
  });

  it("disposes the initialized runtime before rejecting when revoked during initialization", async () => {
    const authority = makeAuthority();
    await expect(revokeDuringInitialization("revoked-init", authority)).rejects.toBe(
      authority.revoked,
    );
    // Cleanup is awaited before the rejection settles.
    expect(srt.initialize).toHaveBeenCalledTimes(1);
    expect(srt.reset).toHaveBeenCalledTimes(1);
    expect(srt.proxyPort).toBeUndefined();
    expect(srt.config).toBeUndefined();
  });

  it("does not dispose a rejected backend again on scope removal or shutdown", async () => {
    const authority = makeAuthority();
    await expect(revokeDuringInitialization("rejected-once", authority)).rejects.toBe(
      authority.revoked,
    );
    await removeScope("rejected-once");
    await shutdownSrtSandboxRuntime();
    expect(srt.reset).toHaveBeenCalledTimes(1);
  });

  it("keeps the host's error when cleanup fails and leaves the runtime faulted", async () => {
    srt.reset.mockRejectedValueOnce(new Error("injected reset failure"));
    const authority = makeAuthority();
    await expect(revokeDuringInitialization("failed-cleanup", authority)).rejects.toBe(
      authority.revoked,
    );
    expect(srt.reset).toHaveBeenCalledTimes(1);

    await expect(factory(makeParams("after-failed-cleanup", makeAuthority()))).rejects.toThrow(
      "runtime cleanup failed; shutdown must succeed before retry",
    );
  });

  it("publishes the backend while authority holds and resets the final owner once", async () => {
    const authority = makeAuthority();
    const initialization = pauseInitialization();
    const pending = factory(makeParams("valid-owner", authority));
    await reached(initialization.started, pending);
    initialization.release();

    const handle = await pending;
    expect(handle.id).toBe(SRT_SANDBOX_BACKEND_ID);
    expect(srt.proxyPort).toBe(PROXY_PORT);

    await removeScope("valid-owner");
    await removeScope("valid-owner");
    await shutdownSrtSandboxRuntime();
    expect(srt.reset).toHaveBeenCalledTimes(1);
    expect(srt.proxyPort).toBeUndefined();
  });

  it("releases a rejected second owner without resetting the first owner's runtime", async () => {
    await factory(makeParams("first-owner", makeAuthority()));

    // The second scope joins the ready runtime; the host revokes it once its
    // lease is acquired, before the factory publishes the handle.
    const second = makeAuthority();
    let checks = 0;
    const params = makeParams("second-owner", second);
    params.assertRuntimeCurrent = () => {
      checks += 1;
      // Entry and post-discovery checks pass; the pre-publication check fails.
      if (checks > 2) {
        second.current = false;
      }
      second.assertRuntimeCurrent();
    };
    await expect(factory(params)).rejects.toBe(second.revoked);
    expect(checks).toBe(3);
    expect(srt.initialize).toHaveBeenCalledTimes(1);
    expect(srt.reset).not.toHaveBeenCalled();
    expect(srt.proxyPort).toBe(PROXY_PORT);

    // The rejected owner's lease is gone: removing the first owner is final.
    await removeScope("first-owner");
    expect(srt.reset).toHaveBeenCalledTimes(1);
    expect(srt.proxyPort).toBeUndefined();
  });
});
