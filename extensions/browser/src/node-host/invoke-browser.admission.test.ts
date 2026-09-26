import { createServer } from "node:http";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { rawDataToString } from "openclaw/plugin-sdk/webhook-ingress";
import { WebSocketServer } from "openclaw/plugin-sdk/websocket-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BROWSER_PROXY_OWNED_TAB_CLOSE_PATH } from "../browser-proxy-envelope.js";
import type { closeTrackedCdpTarget } from "../browser/cdp.helpers.js";
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
  getRuntimeConfig: () => mocks.config,
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
    await expect(
      runBrowserProxyCommand(JSON.stringify({ method: "POST", path: "/stop" })),
    ).rejects.toThrow("node browser proxy disabled");
    expect(write).not.toHaveBeenCalled();
  });

  it("rechecks policy after native ownership discovery before closing a target", async () => {
    let wsUrl = "";
    const server = createServer((_request, response) => {
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ webSocketDebuggerUrl: wsUrl }));
    });
    const sockets = new WebSocketServer({ server });
    const commands: string[] = [];
    sockets.on("connection", (socket) =>
      socket.on("message", (raw) => {
        const message = JSON.parse(rawDataToString(raw)) as { id: number; method: string };
        commands.push(message.method);
        if (message.method === "Target.getTargets") {
          mocks.config = { ...mocks.config, nodeHost: { browserProxy: { enabled: false } } };
        }
        socket.send(
          JSON.stringify({
            id: message.id,
            result:
              message.method === "Target.getTargets"
                ? { targetInfos: [{ targetId: "synthetic-target" }] }
                : { success: true },
          }),
        );
      }),
    );
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("fixture requires a TCP listener");
    }
    const cdpUrl = `http://127.0.0.1:${address.port}`;
    wsUrl = `ws://127.0.0.1:${address.port}/devtools/browser/proof`;
    try {
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
      await runBrowserProxyCommand(
        JSON.stringify({
          method: "POST",
          path: BROWSER_PROXY_OWNED_TAB_CLOSE_PATH,
          body: { ownership: nativeOwnership },
        }),
      );
      expect(commands).not.toContain("Target.closeTarget");
    } finally {
      for (const socket of sockets.clients) {
        socket.terminate();
      }
      await new Promise<void>((resolve) => {
        sockets.close(() => resolve());
      });
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  });

  it("keeps the admitted default profile while staging awaits", async () => {
    mocks.stage.mockImplementationOnce(async ({ body }) => {
      mocks.config = { ...mocks.config, browser: { defaultProfile: "user" } };
      return { body };
    });
    await runBrowserProxyCommand(JSON.stringify({ method: "POST", path: "/stop" }));
    expect(mocks.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ query: { profile: "openclaw" } }),
    );
  });

  it.each(["PUT", "OPTIONS"])(
    "rejects %s before it can become a host-local GET",
    async (method) => {
      await expect(
        runBrowserProxyCommand(JSON.stringify({ method, path: "/system-profiles" })),
      ).rejects.toThrow(/method must be GET, POST, or DELETE/);
      expect(mocks.dispatch).not.toHaveBeenCalled();
    },
  );

  it.each(["GET", "DELETE"])("does not close an owned target through %s", async (method) => {
    await expect(
      runBrowserProxyCommand(
        JSON.stringify({ method, path: BROWSER_PROXY_OWNED_TAB_CLOSE_PATH, body: { ownership } }),
      ),
    ).rejects.toThrow(/requires POST/);
    expect(mocks.close).not.toHaveBeenCalled();
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });

  it.each([
    { phase: "startup", restriction: "disabled" },
    { phase: "startup", restriction: "profile" },
    { phase: "staging", restriction: "disabled" },
    { phase: "staging", restriction: "profile" },
  ] as const)(
    "rechecks $restriction admission after awaited $phase",
    async ({ phase, restriction }) => {
      const entered = createDeferred<void>();
      const released = createDeferred<void>();
      if (phase === "startup") {
        mocks.start.mockImplementationOnce(async () => {
          entered.resolve();
          await released.promise;
          return state;
        });
      } else {
        mocks.stage.mockImplementationOnce(async ({ body }) => {
          entered.resolve();
          await released.promise;
          return { body };
        });
      }
      const run = runBrowserProxyCommand(
        JSON.stringify({ method: "POST", path: "/stop", profile: "openclaw" }),
      );
      const rejected = expect(run).rejects.toThrow(
        restriction === "disabled" ? "node browser proxy disabled" : "browser profile not allowed",
      );
      await entered.promise;
      mocks.config = {
        ...mocks.config,
        nodeHost: {
          browserProxy:
            restriction === "disabled"
              ? { enabled: false }
              : { enabled: true, allowProfiles: ["user"] },
        },
      };
      released.resolve();
      await rejected;
      expect(mocks.dispatch).not.toHaveBeenCalled();
    },
  );
});
