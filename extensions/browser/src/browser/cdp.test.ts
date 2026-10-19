import type { ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { SsrFBlockedError } from "openclaw/plugin-sdk/security-runtime";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import "../test-support/browser-security.mock.js";
import {
  closeTrackedCdpTarget,
  normalizeCdpHttpBaseForJsonEndpoints,
  normalizeCdpWsUrl,
  redactCdpErrorText,
  resolveCdpTabOwnership,
} from "./cdp.helpers.js";
import { createTargetViaCdp, waitForCdpCommittedNavigationUrl } from "./cdp.js";
import { createCdpFixture, cdpResult as result, pageReplies, wsUrl } from "./cdp.test-support.js";
import { BrowserCdpEndpointBlockedError, toBrowserErrorResponse } from "./errors.js";
import { InvalidBrowserNavigationUrlError } from "./navigation-guard.js";

const {
  start: startBrowser,
  close: closeBrowsers,
  listenHttp,
} = createCdpFixture({
  ...pageReplies,
  "Target.detachFromTarget": result(),
  "Target.attachToTarget": result({ sessionId: "S1" }),
});
const strictPolicy = { dangerouslyAllowPrivateNetwork: false, allowedHostnames: ["127.0.0.1"] };
const frameTree = (frame: Record<string, unknown>) => result({ frameTree: { frame } });
function createTarget(
  { cdpUrl }: { cdpUrl: string },
  options: Partial<Parameters<typeof createTargetViaCdp>[0]> = {},
) {
  return createTargetViaCdp({ cdpUrl, url: "https://example.com", ...options });
}

beforeEach(() => {
  for (const key of ["ALL_PROXY", "HTTP_PROXY", "HTTPS_PROXY"]) {
    vi.stubEnv(key, "");
    vi.stubEnv(key.toLowerCase(), "");
  }
});
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await closeBrowsers();
});

it("opens an explicitly allowed private target in the background and prepares its page", async () => {
  const browser = await startBrowser({ "Target.createTarget": result({ targetId: "TARGET" }) });
  await expect(
    createTarget(browser, {
      url: "http://127.0.0.1:8080",
      ssrfPolicy: { allowPrivateNetwork: true },
    }),
  ).resolves.toEqual({ targetId: "TARGET" });
  expect(browser.messages[0]?.params).toEqual({ url: "http://127.0.0.1:8080", background: true });
  expect(browser.messages.map((message) => message.method)).toEqual([
    "Target.createTarget",
    "Target.attachToTarget",
    "Page.enable",
    "Runtime.enable",
    "Network.enable",
    "DOM.enable",
    "Accessibility.enable",
    "Runtime.runIfWaitingForDebugger",
    "Target.detachFromTarget",
  ]);
});

it("returns the stable browser-owned frame URL when requested", async () => {
  let frameReads = 0;
  const browser = await startBrowser({
    "Target.createTarget": result({ targetId: "TARGET" }),
    "Page.getFrameTree": () => {
      frameReads++;
      return frameTree(
        frameReads === 1
          ? { loaderId: "BLANK", url: "about:blank" }
          : {
              loaderId: "FINAL",
              url: "http://127.0.0.1:61501/blocked",
              urlFragment: "#fragment",
            },
      );
    },
  });
  await expect(
    createTarget(browser, {
      url: "https://redirect.example/start",
      waitForNavigationResult: true,
    }),
  ).resolves.toEqual({ targetId: "TARGET", finalUrl: "http://127.0.0.1:61501/blocked#fragment" });
  expect(frameReads).toBeGreaterThan(2);
  expect(browser.messages.map((message) => message.method)).not.toContain("Runtime.evaluate");
});

it.each([
  { abortAt: "creation", closeFails: false },
  { abortAt: "navigation", closeFails: true },
])(
  "closes an unreturned target after $abortAt abort (close fails: $closeFails)",
  async ({ abortAt, closeFails }) => {
    const controller = new AbortController();
    const reason = new Error("cancel after target creation");
    const browser = await startBrowser({
      "Target.createTarget": () => {
        if (abortAt === "creation") {
          controller.abort(reason);
        }
        return result({ targetId: "TARGET" });
      },
      "Target.closeTarget": closeFails
        ? { error: { message: "close failed" } }
        : result({ success: true }),
      "Page.getFrameTree": () => {
        controller.abort(reason);
        return frameTree({ loaderId: "CANCEL", url: "https://example.com" });
      },
    });
    await expect(
      createTarget(browser, {
        signal: controller.signal,
        waitForNavigationResult: true,
      }),
    ).rejects.toBe(reason);
    expect(
      browser.messages
        .filter((message) => message.method === "Target.closeTarget")
        .map((message) => message.params?.targetId),
    ).toEqual(["TARGET"]);
  },
);

it("cancels hanging endpoint discovery without creating a target", async () => {
  const controller = new AbortController();
  const reason = new Error("cancel during endpoint discovery");
  const discovery = Promise.withResolvers<void>();
  let heldResponse: ServerResponse | undefined;
  const browser = await startBrowser(
    {},
    {
      discover: (_request, response) => {
        heldResponse = response;
        discovery.resolve();
      },
    },
  );
  const pending = createTarget(browser, { signal: controller.signal });
  await discovery.promise;
  controller.abort(reason);
  const overdue = Promise.withResolvers<never>();
  const deadline = setTimeout(
    () => overdue.reject(new Error("cancelled discovery remained pending")),
    300,
  );
  try {
    await expect(Promise.race([pending, overdue.promise])).rejects.toBe(reason);
    expect(browser.messages).toEqual([]);
  } finally {
    clearTimeout(deadline);
    heldResponse?.end(JSON.stringify({ webSocketDebuggerUrl: browser.wsUrl }));
    await pending.catch(() => {});
  }
});

it("honors configured HTTP discovery timeouts", async () => {
  const browser = await startBrowser(
    { "Target.createTarget": result({ targetId: "SLOW" }) },
    {
      discover: (_request, response) => {
        setTimeout(() => {
          response.end(JSON.stringify({ webSocketDebuggerUrl: browser.wsUrl }));
        }, 120);
      },
    },
  );
  await expect(createTarget(browser, { timeouts: { httpTimeoutMs: 20 } })).rejects.toThrow(
    /abort|timeout|timed out/i,
  );
});

it("honors configured WebSocket handshake timeouts", async () => {
  const server = await listenHttp();
  const heldSockets: Duplex[] = [];
  server.on("upgrade", (_request, socket) => {
    heldSockets.push(socket);
  });
  const cdpUrl = wsUrl(server).replace("/TEST", "/SLOW");
  try {
    await expect(
      createTarget({ cdpUrl }, { timeouts: { handshakeTimeoutMs: 20 } }),
    ).rejects.toThrow(/handshake|timeout|timed out/i);
  } finally {
    for (const socket of heldSockets) {
      socket.destroy();
    }
  }
});

it.each([
  { url: "http://127.0.0.1:8080", ssrfPolicy: undefined, error: SsrFBlockedError },
  {
    url: "https://example.com",
    ssrfPolicy: { dangerouslyAllowPrivateNetwork: false },
    error: InvalidBrowserNavigationUrlError,
  },
  { url: "file:///etc/passwd", ssrfPolicy: undefined, error: InvalidBrowserNavigationUrlError },
])("blocks disallowed navigation to $url before connecting", async ({ url, ssrfPolicy, error }) => {
  const fetch = vi.spyOn(globalThis, "fetch");
  await expect(
    createTargetViaCdp({ cdpUrl: "http://127.0.0.1:9222", url, ssrfPolicy }),
  ).rejects.toBeInstanceOf(error);
  expect(fetch).not.toHaveBeenCalled();
});

it.each(["configured", "discovered"])(
  "blocks a %s CDP endpoint outside strict policy",
  async (source) => {
    const browser = await startBrowser(
      {},
      {
        advertisedUrl: "ws://169.254.169.254:9222/devtools/browser/PIVOT",
      },
    );
    const cdpUrl = source === "discovered" ? browser.cdpUrl : "http://169.254.169.254:9222";
    await expect(
      createTarget({ cdpUrl }, { url: "https://93.184.216.34", ssrfPolicy: strictPolicy }),
    ).rejects.toBeInstanceOf(BrowserCdpEndpointBlockedError);
    expect(browser.messages).toEqual([]);
  },
);

it("rejects HTTP discovery without a browser websocket URL", async () => {
  const browser = await startBrowser({}, { versionBody: {} });
  await expect(createTarget(browser)).rejects.toThrow(
    "CDP /json/version missing webSocketDebuggerUrl",
  );
});

it.each(["unavailable", "rejected"] as const)(
  "falls back to the WebSocket root when discovery is %s",
  async (failure) => {
    const browser = await startBrowser(
      (message, path) => {
        if (path.startsWith("/e/bad")) {
          return { error: { message: "Browserless endpoint rejected command" } };
        }
        if (message.method === "Target.createTarget") {
          return result({ targetId: "FALLBACK" });
        }
        return undefined;
      },
      {
        discover: (request, response) => {
          if (failure === "unavailable") {
            response.writeHead(404).end();
          } else {
            response.end(
              JSON.stringify({ webSocketDebuggerUrl: `ws://${request.headers.host}/e/bad` }),
            );
          }
        },
      },
    );
    await expect(
      createTarget({
        cdpUrl: browser.cdpUrl.replace("http:", "ws:"),
      }),
    ).resolves.toEqual({ targetId: "FALLBACK" });
  },
);
it("reads the browser frame URL with its fragment", async () => {
  const browser = await startBrowser({
    "Page.getFrameTree": frameTree({
      loaderId: "FINAL",
      url: "https://example.com/final",
      urlFragment: "#section",
    }),
  });
  await expect(
    waitForCdpCommittedNavigationUrl({
      wsUrl: browser.wsUrl,
      configuredCdpUrl: browser.cdpUrl,
      requestedUrl: "https://example.com/start",
    }),
  ).resolves.toBe("https://example.com/final#section");
});

it("propagates a policy-blocked discovered page websocket", async () => {
  await expect(
    waitForCdpCommittedNavigationUrl({
      wsUrl: "ws://169.254.169.254:9222/devtools/page/PIVOT",
      configuredCdpUrl: "http://127.0.0.1:9222",
      cdpPolicy: strictPolicy,
      requestedUrl: "about:blank",
    }),
  ).rejects.toBeInstanceOf(BrowserCdpEndpointBlockedError);
});
it.each(["closed", "declined", "missing", "cancelled"] as const)(
  "keeps closure %s under current ownership",
  async (outcome) => {
    const browser = await startBrowser(
      {
        "Target.getTargets": result({
          targetInfos: [{ targetId: outcome === "missing" ? "USER" : "OWNED", type: "page" }],
        }),
        "Target.closeTarget": result({ success: outcome !== "declined" }),
      },
      { advertisedUrl: "ws://localhost/devtools/browser/SIDECAR" },
    );
    const params = { profileName: "remote", cdpUrl: browser.cdpUrl, nativeTargetId: "OWNED" };
    const ownership = await resolveCdpTabOwnership(params);
    if (ownership.status !== "durable") {
      throw new Error("expected durable ownership");
    }
    await expect(
      closeTrackedCdpTarget({
        ...params,
        expectedProfileFingerprint: ownership.profileFingerprint,
        // Fixed pre-upgrade identity: connections normalize localhost, fingerprints do not.
        expectedBrowserInstanceFingerprint:
          "sha256:e40b808cae2f166a9e1e0f0fc45e3600f01f6dfd5265d9ff59d13de95356dae2",
        ...(outcome === "cancelled"
          ? { closeIfCurrent: async () => ({ status: "cancelled" as const }) }
          : {}),
      }),
    ).resolves.toEqual(
      outcome === "declined"
        ? { status: "unavailable", reason: "target-close-failed" }
        : { status: outcome },
    );
    expect(browser.messages.map((message) => message.method)).toEqual(
      outcome === "closed" || outcome === "declined"
        ? ["Target.getTargets", "Target.closeTarget"]
        : ["Target.getTargets"],
    );
  },
);

it("does not inspect or close targets after browser ownership changes", async () => {
  const browser = await startBrowser({});
  await expect(
    closeTrackedCdpTarget({
      profileName: "remote",
      cdpUrl: browser.cdpUrl,
      nativeTargetId: "REUSED",
      expectedProfileFingerprint: "sha256:old-profile",
      expectedBrowserInstanceFingerprint: "sha256:old-browser",
    }),
  ).resolves.toEqual({ status: "ownership-mismatch" });
  expect(browser.messages).toEqual([]);
});
const blockedTarget = Object.assign(new Error("Target blocked"), {
  name: "BlockedBrowserTargetError",
});
it.each([
  [blockedTarget, 409, "Target blocked", "navigation_blocked"],
  [
    new SsrFBlockedError("raw private-network policy"),
    400,
    "browser navigation blocked by policy",
    "navigation_blocked",
  ],
  [new BrowserCdpEndpointBlockedError(), 400, "browser endpoint blocked by policy", undefined],
] as const)(
  "maps browser error %s without exposing policy details",
  (error, status, message, reason) => {
    expect(toBrowserErrorResponse(error)).toEqual({
      status,
      message,
      ...(reason ? { reason } : {}),
    });
  },
);

it.each([
  [
    "ws://0.0.0.0:3000/devtools/browser/ABC?session=1&token=ws-token",
    "https://user:pass@example.com:9443?token=cdp-token&apiKey=abc",
    "wss://user:pass@example.com:9443/devtools/browser/ABC?session=1&token=ws-token&apiKey=abc",
  ],
  [
    "ws://[::]:3000/devtools/browser/ABC",
    "http://example.com",
    "ws://example.com/devtools/browser/ABC",
  ],
  ["ws://remote.example", "https://remote.example?token=abc", "wss://remote.example/?token=abc"],
])("normalizes %s against the configured authority", (reported, configured, expected) => {
  expect(normalizeCdpWsUrl(reported, configured)).toBe(expected);
});

it("normalizes WebSocket endpoints and malformed URL fallbacks", () => {
  expect(normalizeCdpHttpBaseForJsonEndpoints("ws://host:9222/cdp")).toBe("http://host:9222");
  expect(normalizeCdpHttpBaseForJsonEndpoints("wss://host/devtools/browser/abc?t=1")).toBe(
    "https://host/?t=1",
  );
  expect(normalizeCdpHttpBaseForJsonEndpoints("ws://").startsWith("http:")).toBe(true);
});

it("redacts embedded CDP URL credentials from dependency error prose", () => {
  const message = redactCdpErrorText(
    "connect failed for wss://alice:browser-password@browserless.example/devtools/browser/id?token=browser-token",
  );

  expect(message).toContain("browserless.example/devtools/browser/id");
  expect(message).not.toMatch(/alice|browser-password|browser-token/);
});
