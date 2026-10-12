import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { SsrFBlockedError } from "openclaw/plugin-sdk/security-runtime";
import { rawDataToString } from "openclaw/plugin-sdk/webhook-ingress";
import { WebSocketServer } from "openclaw/plugin-sdk/websocket-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../test-support/browser-security.mock.js";
import {
  closeTrackedCdpTarget,
  normalizeCdpHttpBaseForJsonEndpoints,
  normalizeCdpWsUrl,
  redactCdpErrorText,
  resolveCdpTabOwnership,
} from "./cdp.helpers.js";
import { createTargetViaCdp, waitForCdpCommittedNavigationUrl } from "./cdp.js";
import { BrowserCdpEndpointBlockedError, toBrowserErrorResponse } from "./errors.js";
import { InvalidBrowserNavigationUrlError } from "./navigation-guard.js";

type Message = { id?: number; method?: string; params?: Record<string, unknown> };
type Reply = { result: Record<string, unknown> } | { error: { message: string } };
const servers: Array<{ close: (callback: () => void) => void }> = [];
const enabledMethods = new Set([
  "Target.detachFromTarget",
  "Page.enable",
  "Runtime.enable",
  "Network.enable",
  "DOM.enable",
  "Accessibility.enable",
  "Runtime.runIfWaitingForDebugger",
]);
const strictPolicy = { dangerouslyAllowPrivateNetwork: false, allowedHostnames: ["127.0.0.1"] };

async function startBrowser(
  handle: (message: Message, path: string) => Reply | undefined,
  options: {
    advertisedUrl?: string;
    versionBody?: Record<string, unknown>;
    discover?: (request: IncomingMessage, response: ServerResponse) => void;
  } = {},
) {
  let wsUrl = "";
  const http = createServer((request, response) => {
    if (request.url !== "/json/version") {
      response.writeHead(404).end();
      return;
    }
    if (options.discover) {
      return options.discover(request, response);
    }
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify(
        options.versionBody ?? { webSocketDebuggerUrl: options.advertisedUrl ?? wsUrl },
      ),
    );
  });
  const ws = new WebSocketServer({ server: http });
  servers.push(ws, http);
  const messages: Message[] = [];
  ws.on("connection", (socket, request) => {
    socket.on("message", (raw) => {
      const message = JSON.parse(rawDataToString(raw)) as Message;
      messages.push(message);
      const reply =
        handle(message, request.url ?? "") ??
        (message.method === "Target.attachToTarget"
          ? { result: { sessionId: "S1" } }
          : enabledMethods.has(message.method ?? "")
            ? { result: {} }
            : undefined);
      if (reply) {
        socket.send(JSON.stringify({ id: message.id, ...reply }));
      }
    });
  });
  await new Promise<void>((resolve) => {
    http.listen(0, "127.0.0.1", resolve);
  });
  const cdpUrl = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  wsUrl = `${cdpUrl.replace("http:", "ws:")}/devtools/browser/TEST`;
  return { cdpUrl, wsUrl, messages };
}

beforeEach(() => {
  for (const key of [
    "ALL_PROXY",
    "all_proxy",
    "HTTP_PROXY",
    "http_proxy",
    "HTTPS_PROXY",
    "https_proxy",
  ]) {
    vi.stubEnv(key, "");
  }
});
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(resolve);
        }),
    ),
  );
});

describe("CDP target creation", () => {
  it("opens an explicitly allowed private target in the background and prepares its page", async () => {
    const browser = await startBrowser((message) =>
      message.method === "Target.createTarget" ? { result: { targetId: "TARGET" } } : undefined,
    );
    await expect(
      createTargetViaCdp({
        cdpUrl: browser.cdpUrl,
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
    const browser = await startBrowser((message) => {
      if (message.method === "Target.createTarget") {
        return { result: { targetId: "TARGET" } };
      }
      if (message.method === "Page.getFrameTree") {
        frameReads++;
        return {
          result: {
            frameTree: {
              frame:
                frameReads === 1
                  ? { loaderId: "BLANK", url: "about:blank" }
                  : {
                      loaderId: "FINAL",
                      url: "http://127.0.0.1:61501/blocked",
                      urlFragment: "#fragment",
                    },
            },
          },
        };
      }
      return undefined;
    });
    await expect(
      createTargetViaCdp({
        cdpUrl: browser.cdpUrl,
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
      const browser = await startBrowser((message) => {
        if (message.method === "Target.createTarget") {
          if (abortAt === "creation") {
            controller.abort(reason);
          }
          return { result: { targetId: "TARGET" } };
        }
        if (message.method === "Target.closeTarget") {
          return closeFails
            ? { error: { message: "close failed" } }
            : { result: { success: true } };
        }
        if (message.method === "Page.getFrameTree") {
          controller.abort(reason);
          return {
            result: { frameTree: { frame: { loaderId: "CANCEL", url: "https://example.com" } } },
          };
        }
        return undefined;
      });
      await expect(
        createTargetViaCdp({
          cdpUrl: browser.cdpUrl,
          url: "https://example.com",
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
    const browser = await startBrowser(() => undefined, {
      discover: (_request, response) => {
        heldResponse = response;
        discovery.resolve();
      },
    });
    const pending = createTargetViaCdp({
      cdpUrl: browser.cdpUrl,
      url: "https://example.com",
      signal: controller.signal,
    });
    await discovery.promise;
    controller.abort(reason);
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      await expect(
        Promise.race([
          pending,
          new Promise<never>((_resolve, reject) => {
            deadline = setTimeout(
              () => reject(new Error("cancelled discovery remained pending")),
              300,
            );
          }),
        ]),
      ).rejects.toBe(reason);
      expect(browser.messages).toEqual([]);
    } finally {
      clearTimeout(deadline);
      heldResponse?.end(JSON.stringify({ webSocketDebuggerUrl: browser.wsUrl }));
      await pending.catch(() => {});
    }
  });

  it("honors configured HTTP discovery timeouts", async () => {
    const browser = await startBrowser(
      (message) =>
        message.method === "Target.createTarget" ? { result: { targetId: "SLOW" } } : undefined,
      {
        discover: (_request, response) => {
          setTimeout(() => {
            response.end(JSON.stringify({ webSocketDebuggerUrl: browser.wsUrl }));
          }, 120);
        },
      },
    );
    await expect(
      createTargetViaCdp({
        cdpUrl: browser.cdpUrl,
        url: "https://example.com",
        timeouts: { httpTimeoutMs: 20 },
      }),
    ).rejects.toThrow(/abort|timeout|timed out/i);
  });

  it("honors configured WebSocket handshake timeouts", async () => {
    const server = createServer();
    servers.push(server);
    const heldSockets: Duplex[] = [];
    server.on("upgrade", (_request, socket) => {
      heldSockets.push(socket);
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    try {
      await expect(
        createTargetViaCdp({
          cdpUrl: `ws://127.0.0.1:${(server.address() as AddressInfo).port}/devtools/browser/SLOW`,
          url: "https://example.com",
          timeouts: { handshakeTimeoutMs: 20 },
        }),
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
  ])(
    "blocks disallowed navigation to $url before connecting",
    async ({ url, ssrfPolicy, error }) => {
      const fetch = vi.spyOn(globalThis, "fetch");
      await expect(
        createTargetViaCdp({ cdpUrl: "http://127.0.0.1:9222", url, ssrfPolicy }),
      ).rejects.toBeInstanceOf(error);
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it("blocks a cross-host websocket pivot returned by discovery", async () => {
    const browser = await startBrowser(() => undefined, {
      advertisedUrl: "ws://169.254.169.254:9222/devtools/browser/PIVOT",
    });
    await expect(
      createTargetViaCdp({
        cdpUrl: browser.cdpUrl,
        url: "https://93.184.216.34",
        ssrfPolicy: strictPolicy,
      }),
    ).rejects.toBeInstanceOf(BrowserCdpEndpointBlockedError);
    expect(browser.messages).toEqual([]);
  });

  it("blocks a configured CDP host outside strict policy before discovery", async () => {
    await expect(
      createTargetViaCdp({
        cdpUrl: "http://169.254.169.254:9222",
        url: "https://93.184.216.34",
        ssrfPolicy: strictPolicy,
      }),
    ).rejects.toBeInstanceOf(BrowserCdpEndpointBlockedError);
  });

  it("rejects HTTP discovery without a browser websocket URL", async () => {
    const browser = await startBrowser(() => undefined, { versionBody: {} });
    await expect(
      createTargetViaCdp({ cdpUrl: browser.cdpUrl, url: "https://example.com" }),
    ).rejects.toThrow("CDP /json/version missing webSocketDebuggerUrl");
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
            return { result: { targetId: "FALLBACK" } };
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
        createTargetViaCdp({
          cdpUrl: browser.cdpUrl.replace("http:", "ws:"),
          url: "https://example.com",
        }),
      ).resolves.toEqual({ targetId: "FALLBACK" });
    },
  );
});

describe("CDP committed navigation", () => {
  it("reads the browser frame URL with its fragment", async () => {
    const browser = await startBrowser((message) =>
      message.method === "Page.getFrameTree"
        ? {
            result: {
              frameTree: {
                frame: {
                  loaderId: "FINAL",
                  url: "https://example.com/final",
                  urlFragment: "#section",
                },
              },
            },
          }
        : undefined,
    );
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
});

describe("tracked CDP target closure", () => {
  it.each(["closed", "declined", "missing", "cancelled"] as const)(
    "keeps closure %s under current ownership",
    async (outcome) => {
      const browser = await startBrowser(
        (message) => {
          if (message.method === "Target.getTargets") {
            return {
              result: {
                targetInfos: [{ targetId: outcome === "missing" ? "USER" : "OWNED", type: "page" }],
              },
            };
          }
          if (message.method === "Target.closeTarget") {
            return { result: { success: outcome !== "declined" } };
          }
          return undefined;
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
    const browser = await startBrowser(() => undefined);
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
});

describe("browser error mapping", () => {
  it("maps blocked browser targets to conflict responses", () => {
    const err = new Error("Target blocked after navigation");
    err.name = "BlockedBrowserTargetError";
    expect(toBrowserErrorResponse(err)).toEqual({
      status: 409,
      message: err.message,
      reason: "navigation_blocked",
    });
  });
  it("sanitizes navigation-target SSRF policy details", () => {
    expect(toBrowserErrorResponse(new SsrFBlockedError("raw private-network policy"))).toEqual({
      status: 400,
      message: "browser navigation blocked by policy",
      reason: "navigation_blocked",
    });
  });
  it("distinguishes endpoint policy blocks from navigation errors", () => {
    expect(toBrowserErrorResponse(new BrowserCdpEndpointBlockedError())).toEqual({
      status: 400,
      message: "browser endpoint blocked by policy",
    });
  });
});

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

describe("CDP URL edge cases", () => {
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
    expect(message).not.toContain("alice");
    expect(message).not.toContain("browser-password");
    expect(message).not.toContain("browser-token");
  });
});
