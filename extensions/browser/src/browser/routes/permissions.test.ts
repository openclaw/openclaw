import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  BROWSER_ERROR_REASONS,
  BrowserProfileUnavailableError,
  type BrowserNoDisplayErrorMetadata,
} from "../errors.js";
import { makeBrowserProfile } from "../server-context.test-harness.js";
import { createRouteFixture } from "./request.test-support.js";

type Send = (method: string, params?: Record<string, unknown>) => Promise<Record<string, unknown>>;
const cdpMocks = vi.hoisted(() => ({
  getChromeWebSocketEndpoint: vi.fn(async () => ({
    url: "ws://127.0.0.1:18800/devtools/browser/test",
  })),
  send: vi.fn<Send>(async () => ({})),
  withCdpSocket: vi.fn(
    async (_wsUrl: string, fn: (send: Send) => Promise<unknown>) => await fn(cdpMocks.send),
  ),
}));

const pwMocks = vi.hoisted(() => ({
  getPwAiModule: vi.fn(async () => null),
  grantPermissions: vi.fn(async () => {}),
  getPageForTargetId: vi.fn(async () => ({
    context: () => ({ grantPermissions: pwMocks.grantPermissions }),
  })),
}));

vi.mock("../chrome.js", () => ({
  getChromeWebSocketEndpoint: cdpMocks.getChromeWebSocketEndpoint,
}));

// mock-isolation: Permission routes use a synthetic CDP transport, never a live browser socket.
vi.mock("../cdp.helpers.js", () => ({ withCdpSocket: cdpMocks.withCdpSocket }));
// mock-isolation: Exercise Playwright-present and CDP-fallback routes without loading Playwright.
vi.mock("../pw-ai-module.js", () => ({ getPwAiModule: pwMocks.getPwAiModule }));
const { registerBrowserPermissionRoutes } = await import("./permissions.js");

const origin = "https://meet.google.com";
const cdpUrl = "http://127.0.0.1:18800";
const requiredPermissions = ["audioCapture", "videoCapture"];
const optionalPermissions = ["speakerSelection"];
const mediaRequest = {
  origin: `${origin}/abc-defg-hij`,
  permissions: requiredPermissions,
  optionalPermissions,
};
function expectGrant(
  response: Awaited<ReturnType<ReturnType<typeof createRouteFixture>["request"]>>,
  grantMethod: "playwright" | "cdp",
  unsupportedPermissions: string[] = [],
) {
  expect(response.statusCode).toBe(200);
  expect(response.body).toStrictEqual({
    ok: true,
    origin,
    grantedPermissions: unsupportedPermissions.length
      ? requiredPermissions
      : [...requiredPermissions, ...optionalPermissions],
    unsupportedPermissions,
    grantMethod,
  });
}

async function callGrant(
  body: Record<string, unknown>,
  options: {
    profile?: Parameters<typeof makeBrowserProfile>[0];
    ssrfPolicy?: Record<string, unknown>;
    ensureBrowserAvailable?: () => Promise<void>;
  } = {},
) {
  const routes = createRouteFixture();
  const profileCtx = {
    profile: makeBrowserProfile(options.profile),
    ensureBrowserAvailable: vi.fn(options.ensureBrowserAvailable ?? (async () => {})),
  };
  registerBrowserPermissionRoutes(routes.app, {
    state: () => ({
      resolved: { ssrfPolicy: options.ssrfPolicy ?? { allowPrivateNetwork: false } },
    }),
    forProfile: () => profileCtx,
  } as never);
  const response = await routes.request("post", "/permissions/grant", {
    body: { origin, permissions: ["audioCapture"], ...body },
  });
  return { response, profileCtx };
}

describe("browser permission routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cdpMocks.send.mockReset().mockResolvedValue({});
    pwMocks.getPwAiModule.mockReset().mockResolvedValue(null);
  });

  it("uses Playwright context permissions for attached pages when available", async () => {
    pwMocks.getPwAiModule.mockResolvedValue({
      getPageForTargetId: pwMocks.getPageForTargetId,
    } as never);

    const { response } = await callGrant({ ...mediaRequest, targetId: "meet-tab" });

    expectGrant(response, "playwright", optionalPermissions);
    expect(pwMocks.grantPermissions).toHaveBeenCalledWith(["microphone", "camera"], {
      origin: "https://meet.google.com",
    });
    expect(cdpMocks.send).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "grants required Chrome permissions (optional unsupported=%s)",
    async (unsupported) => {
      cdpMocks.send.mockImplementation(async (_method, params) => {
        if (
          unsupported &&
          Array.isArray(params?.permissions) &&
          params.permissions.includes("speakerSelection")
        ) {
          throw new Error("Unknown permission type");
        }
        return {};
      });
      const { response } = await callGrant({ ...mediaRequest, timeoutMs: 1234 });
      expectGrant(response, "cdp", unsupported ? optionalPermissions : []);
      expect(cdpMocks.getChromeWebSocketEndpoint).toHaveBeenCalledWith(cdpUrl, 1234, undefined);
      expect(cdpMocks.send).toHaveBeenLastCalledWith("Browser.grantPermissions", {
        origin,
        permissions: unsupported
          ? requiredPermissions
          : [...requiredPermissions, ...optionalPermissions],
      });
    },
  );

  it("preserves structured browser availability errors", async () => {
    const metadata: BrowserNoDisplayErrorMetadata = {
      reason: BROWSER_ERROR_REASONS.noDisplayForHeadedProfile,
      details: {
        profile: "openclaw",
        requestedHeadless: false,
        headlessSource: "config",
        displayPresent: false,
      },
    };
    const error = new BrowserProfileUnavailableError(
      'Managed browser profile "openclaw" requires a display.',
      { metadata },
    );
    const { response } = await callGrant(
      {},
      { ensureBrowserAvailable: () => Promise.reject(error) },
    );

    expect(response.statusCode).toBe(409);
    expect(response.body).toStrictEqual({ error: error.message, ...metadata });
    expect(cdpMocks.getChromeWebSocketEndpoint).not.toHaveBeenCalled();
  });

  it("rejects loose timeoutMs values before granting permissions", async () => {
    const { response, profileCtx } = await callGrant({ timeoutMs: "1e3" });

    expect(response.statusCode).toBe(400);
    expect(response.body).toStrictEqual({ error: "timeoutMs must be a positive integer." });
    expect(profileCtx.ensureBrowserAvailable).not.toHaveBeenCalled();
    expect(cdpMocks.getChromeWebSocketEndpoint).not.toHaveBeenCalled();
    expect(cdpMocks.send).not.toHaveBeenCalled();
  });

  it("uses exact remote CDP control policy for permission discovery", async () => {
    const { response } = await callGrant(
      {},
      {
        profile: {
          name: "remote",
          cdpUrl: "https://browser.example:9222",
          cdpHost: "browser.example",
          cdpIsLoopback: false,
        },
        ssrfPolicy: {
          allowPrivateNetwork: true,
          allowedOrigins: ["https://navigation.example"],
        },
      },
    );

    expect(response.statusCode).toBe(200);
    expect(cdpMocks.getChromeWebSocketEndpoint).toHaveBeenCalledWith(
      "https://browser.example:9222",
      5000,
      { allowPrivateNetwork: true, allowedHostnames: ["browser.example"] },
    );
  });
});
