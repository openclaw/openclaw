import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BROWSER_PROXY_OWNED_TAB_CLOSE_PATH } from "../browser-proxy-envelope.js";
import type { closeTrackedCdpTarget } from "../browser/cdp.helpers.js";
import { createCdpFixture } from "../browser/cdp.test-support.js";
import { resolveBrowserConfig } from "../browser/config.js";
import type { BrowserDispatchRequest } from "../browser/routes/dispatcher.js";
import type { BrowserServerState } from "../browser/server-context.js";

const mocks = vi.hoisted(() => ({
  config: {} as OpenClawConfig,
  start: vi.fn<() => Promise<BrowserServerState | null>>(),
  dispatch:
    vi.fn<(request: BrowserDispatchRequest) => Promise<{ status: number; body: unknown }>>(),
  stage: vi.fn<(request: { body: unknown }) => Promise<{ body: unknown }>>(),
  close: vi.fn<typeof closeTrackedCdpTarget>(async () => ({ status: "closed" })),
}));
vi.mock("openclaw/plugin-sdk/runtime-config-snapshot", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/runtime-config-snapshot")>()),
  readRuntimeConfig: () => mocks.config,
  getRuntimeConfigSourceSnapshot: () => mocks.config,
}));
vi.mock("../control-service.js", () => ({
  createBrowserControlContext: () => ({}),
  getBrowserControlState: () => null,
  startBrowserControlServiceFromConfig: mocks.start,
}));
vi.mock("../browser/routes/dispatcher.js", () => ({
  createBrowserRouteDispatcher: () => ({ dispatch: mocks.dispatch }),
}));
vi.mock("../browser-proxy-upload.js", () => ({
  hasBrowserProxyUploadWork: () => false,
  ensureBrowserProxyUploadCleanup: async () => {},
  stageBrowserProxyUploadRequest: mocks.stage,
  discardStagedBrowserProxyUpload: async () => {},
}));
vi.mock("../browser/cdp.helpers.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../browser/cdp.helpers.js")>()),
  closeTrackedCdpTarget: mocks.close,
  redactCdpUrl: (url: string) => url,
}));

import { runBrowserProxyCommand } from "./invoke-browser.js";

function invoke(params: Record<string, unknown> = {}) {
  return runBrowserProxyCommand(JSON.stringify({ method: "POST", path: "/stop", ...params }));
}

const ownership = {
  status: "durable",
  nativeTargetId: "synthetic-target",
  profileFingerprint: "sha256:profile",
  browserInstanceFingerprint: "sha256:browser",
};
let state: BrowserServerState;
beforeEach(() => {
  mocks.config = { browser: {}, nodeHost: { browserProxy: { enabled: true } } };
  state = { server: null, port: 18791, resolved: resolveBrowserConfig({}), profiles: new Map() };
  mocks.start.mockReset().mockResolvedValue(state);
  mocks.dispatch.mockReset().mockResolvedValue({ status: 200, body: { ok: true } });
  mocks.stage.mockReset().mockImplementation(async ({ body }) => ({ body }));
  mocks.close.mockClear();
});

describe("node browser proxy admission", () => {
  it("checks current policy inside the admitted route before its write", async () => {
    const write = vi.fn();
    mocks.dispatch.mockImplementationOnce(async (request) => {
      mocks.config = { ...mocks.config, nodeHost: { browserProxy: { enabled: false } } };
      await request.assertCurrent?.();
      write();
      return { status: 200, body: { ok: true } };
    });
    await expect(invoke()).rejects.toThrow("node browser proxy disabled");
    expect(write).not.toHaveBeenCalled();
  });

  it("rechecks policy after native ownership discovery before closing a target", async () => {
    const fixture = createCdpFixture({});
    try {
      const { cdpUrl, messages } = await fixture.start((message) => {
        if (message.method === "Target.getTargets") {
          mocks.config = { ...mocks.config, nodeHost: { browserProxy: { enabled: false } } };
        }
        return {
          result:
            message.method === "Target.getTargets"
              ? { targetInfos: [{ targetId: "synthetic-target" }] }
              : { success: true },
        };
      });
      mocks.config = {
        ...mocks.config,
        browser: { profiles: { openclaw: { cdpUrl, attachOnly: true } } },
      };
      const cdp = await vi.importActual<typeof import("../browser/cdp.helpers.js")>(
        "../browser/cdp.helpers.js",
      );
      const nativeOwnership = await cdp.resolveCdpTabOwnership({
        profileName: "openclaw",
        cdpUrl,
        nativeTargetId: "synthetic-target",
      });
      expect(nativeOwnership.status).toBe("durable");
      mocks.close.mockImplementationOnce(cdp.closeTrackedCdpTarget);
      await invoke({
        path: BROWSER_PROXY_OWNED_TAB_CLOSE_PATH,
        body: { ownership: nativeOwnership },
      });
      expect(messages.map(({ method }) => method)).not.toContain("Target.closeTarget");
    } finally {
      await fixture.close();
    }
  });

  it("keeps the admitted default profile while staging awaits", async () => {
    mocks.stage.mockImplementationOnce(async ({ body }) => {
      mocks.config = { ...mocks.config, browser: { defaultProfile: "user" } };
      return { body };
    });
    await invoke();
    expect(mocks.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ query: { profile: "openclaw" } }),
    );
  });

  it.each([
    { method: "PUT", path: "/system-profiles", error: /method must be GET, POST, or DELETE/ },
    { method: "DELETE", path: BROWSER_PROXY_OWNED_TAB_CLOSE_PATH, error: /requires POST/ },
  ])("rejects $method on $path before dispatch", async ({ method, path, error }) => {
    await expect(invoke({ method, path, body: { ownership } })).rejects.toThrow(error);
    expect(mocks.close).not.toHaveBeenCalled();
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });

  it.each([
    { phase: "startup", policy: { enabled: false }, error: "node browser proxy disabled" },
    {
      phase: "staging",
      policy: { enabled: true, allowProfiles: ["user"] },
      error: "browser profile not allowed",
    },
  ])("rechecks admission after awaited $phase", async ({ phase, policy, error }) => {
    const entered = createDeferred<void>();
    const released = createDeferred<void>();
    async function pause<T>(value: T) {
      entered.resolve();
      await released.promise;
      return value;
    }
    if (phase === "startup") {
      mocks.start.mockImplementationOnce(() => pause(state));
    } else {
      mocks.stage.mockImplementationOnce(({ body }) => pause({ body }));
    }
    const run = invoke({ profile: "openclaw" });
    const rejected = expect(run).rejects.toThrow(error);
    await entered.promise;
    mocks.config = { ...mocks.config, nodeHost: { browserProxy: policy } };
    released.resolve();
    await rejected;
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });
});
