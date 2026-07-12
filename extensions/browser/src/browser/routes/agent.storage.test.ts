// Browser tests cover agent.storage plugin behavior.
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  parseCookieSetOptions,
  parseGeolocationOptions,
  parseRequiredStorageMutationRequest,
  parseStorageKind,
  parseStorageMutationRequest,
  registerBrowserAgentStorageRoutes,
} from "./agent.storage.js";
import { createBrowserRouteApp, createBrowserRouteResponse } from "./test-helpers.js";

const pwMocks = vi.hoisted(() => ({
  setGeolocationViaPlaywright: vi.fn(async () => {}),
}));

vi.mock("../pw-ai-module.js", () => ({
  getPwAiModule: vi.fn(async () => pwMocks),
}));

function createProfileContext() {
  return {
    profile: {
      name: "openclaw",
      cdpUrl: "http://127.0.0.1:18800",
      cdpHost: "127.0.0.1",
      cdpIsLoopback: true,
      driver: "openclaw",
    },
    ensureBrowserAvailable: vi.fn(async () => {}),
    ensureTabAvailable: vi.fn(async (targetId?: string) => ({
      targetId: targetId || "tab-1",
      url: "https://current.example/page",
    })),
    isHttpReachable: vi.fn(),
    isTransportAvailable: vi.fn(),
    isReachable: vi.fn(),
    listTabs: vi.fn(async () => []),
    openTab: vi.fn(),
    labelTab: vi.fn(),
    focusTab: vi.fn(),
    closeTab: vi.fn(),
    stopRunningBrowser: vi.fn(),
    resetProfile: vi.fn(),
  };
}

function createRouteContext(profileCtx: ReturnType<typeof createProfileContext>) {
  return {
    state: () => ({
      resolved: {
        actionTimeoutMs: 5_000,
        ssrfPolicy: { allowPrivateNetwork: false },
      },
    }),
    forProfile: () => profileCtx,
    listProfiles: vi.fn(async () => []),
    mapTabError: vi.fn(() => null),
    ...profileCtx,
  };
}

async function callSetGeolocation(body: Record<string, unknown>) {
  const { app, postHandlers } = createBrowserRouteApp();
  const profileCtx = createProfileContext();
  registerBrowserAgentStorageRoutes(app, createRouteContext(profileCtx) as never);
  const handler = postHandlers.get("/set/geolocation");
  expect(handler).toBeTypeOf("function");

  const response = createBrowserRouteResponse();
  await handler?.({ params: {}, query: {}, body }, response.res);
  return { response, profileCtx };
}

describe("browser storage route parsing", () => {
  beforeEach(() => {
    pwMocks.setGeolocationViaPlaywright.mockClear();
  });

  describe("parseStorageKind", () => {
    it("accepts local and session", () => {
      expect(parseStorageKind("local")).toBe("local");
      expect(parseStorageKind("session")).toBe("session");
    });

    it("rejects unsupported values", () => {
      expect(parseStorageKind("cookie")).toBeNull();
      expect(parseStorageKind("")).toBeNull();
    });
  });

  describe("parseCookieSetOptions", () => {
    it("parses valid cookie expiry numbers and decimal strings", () => {
      expect(
        parseCookieSetOptions({
          name: "session",
          value: "abc",
          url: "https://example.com",
          expires: "1893456000.5",
          httpOnly: true,
          sameSite: "Lax",
        }),
      ).toEqual({
        name: "session",
        value: "abc",
        url: "https://example.com",
        domain: undefined,
        path: undefined,
        expires: 1893456000.5,
        httpOnly: true,
        secure: undefined,
        sameSite: "Lax",
      });
    });

    it("omits blank optional cookie expiry values", () => {
      expect(parseCookieSetOptions({ name: "session", value: "abc", expires: "  " })).toMatchObject(
        {
          name: "session",
          value: "abc",
          expires: undefined,
        },
      );
    });

    it("rejects loose cookie expiry tokens", () => {
      expect(() =>
        parseCookieSetOptions({ name: "session", value: "abc", expires: "0x10" }),
      ).toThrow("cookie.expires must be a finite number.");
    });
  });

  describe("parseStorageMutationRequest", () => {
    it("returns parsed kind and trimmed target id", () => {
      expect(
        parseStorageMutationRequest("local", {
          targetId: "  page-1  ",
        }),
      ).toEqual({
        kind: "local",
        targetId: "page-1",
      });
    });

    it("returns null kind and undefined target id for invalid values", () => {
      expect(
        parseStorageMutationRequest("invalid", {
          targetId: "   ",
        }),
      ).toEqual({
        kind: null,
        targetId: undefined,
      });
    });
  });

  describe("parseRequiredStorageMutationRequest", () => {
    it("returns parsed request for supported kinds", () => {
      expect(
        parseRequiredStorageMutationRequest("session", {
          targetId: " tab-9 ",
        }),
      ).toEqual({
        kind: "session",
        targetId: "tab-9",
      });
    });

    it("returns null for unsupported kind", () => {
      expect(
        parseRequiredStorageMutationRequest("cookie", {
          targetId: "tab-1",
        }),
      ).toBeNull();
    });
  });

  describe("parseGeolocationOptions", () => {
    it("parses valid geolocation numbers and decimal strings", () => {
      expect(
        parseGeolocationOptions({
          latitude: "48.2082",
          longitude: 16.3738,
          accuracy: "12.5",
          origin: " https://example.com/path?query=1#hash ",
        }),
      ).toEqual({
        clear: false,
        latitude: 48.2082,
        longitude: 16.3738,
        accuracy: 12.5,
        origin: "https://example.com",
      });
    });

    it("allows clearing without parsing unused geolocation fields", () => {
      expect(
        parseGeolocationOptions({
          clear: true,
          latitude: "not-used",
          longitude: "not-used",
          accuracy: "not-used",
          origin: "not a url",
        }),
      ).toEqual({
        clear: true,
      });
    });

    it("rejects missing coordinates unless clearing", () => {
      expect(() => parseGeolocationOptions({ latitude: 48 })).toThrow(
        "latitude and longitude are required (or set clear=true)",
      );
    });

    it("rejects malformed and out-of-range geolocation numbers", () => {
      expect(() => parseGeolocationOptions({ latitude: "0x10", longitude: 16 })).toThrow(
        "latitude must be a finite number.",
      );
      expect(() => parseGeolocationOptions({ latitude: 91, longitude: 16 })).toThrow(
        "latitude must be between -90 and 90.",
      );
      expect(() => parseGeolocationOptions({ latitude: 48, longitude: -181 })).toThrow(
        "longitude must be between -180 and 180.",
      );
      expect(() => parseGeolocationOptions({ latitude: 48, longitude: 16, accuracy: -1 })).toThrow(
        "accuracy must be non-negative.",
      );
    });

    it("rejects malformed and non-http geolocation origins", () => {
      expect(() =>
        parseGeolocationOptions({ latitude: 48, longitude: 16, origin: "file:///tmp/page.html" }),
      ).toThrow("origin must be an http(s) origin");
      expect(() =>
        parseGeolocationOptions({ latitude: 48, longitude: 16, origin: "not a url" }),
      ).toThrow("origin must be an http(s) origin");
    });
  });

  describe("/set/geolocation", () => {
    it("normalizes supplied origin before applying geolocation", async () => {
      const { response, profileCtx } = await callSetGeolocation({
        latitude: "48.2082",
        longitude: 16.3738,
        accuracy: "12.5",
        origin: " https://geo.example/path?query=1#hash ",
        targetId: "geo-tab",
      });

      expect(response.statusCode).toBe(200);
      expect(response.body).toStrictEqual({ ok: true, targetId: "geo-tab" });
      expect(profileCtx.ensureTabAvailable).toHaveBeenCalledWith("geo-tab", {
        allowPlaywrightFallback: true,
        signal: expect.any(AbortSignal),
        timeoutMs: 5_000,
      });
      expect(pwMocks.setGeolocationViaPlaywright).toHaveBeenCalledWith(
        expect.objectContaining({
          cdpUrl: "http://127.0.0.1:18800",
          targetId: "geo-tab",
          latitude: 48.2082,
          longitude: 16.3738,
          accuracy: 12.5,
          origin: "https://geo.example",
        }),
      );
    });

    it.each(["file:///tmp/page.html", "not a url"])(
      "rejects %s before applying geolocation",
      async (origin) => {
        const { response, profileCtx } = await callSetGeolocation({
          latitude: 48,
          longitude: 16,
          origin,
        });

        expect(response.statusCode).toBe(400);
        expect(response.body).toStrictEqual({ error: "origin must be an http(s) origin" });
        expect(profileCtx.ensureTabAvailable).not.toHaveBeenCalled();
        expect(pwMocks.setGeolocationViaPlaywright).not.toHaveBeenCalled();
      },
    );

    it("clears geolocation even when unused origin is malformed", async () => {
      const { response, profileCtx } = await callSetGeolocation({
        clear: true,
        latitude: "not-used",
        longitude: "not-used",
        origin: "not a url",
        targetId: "geo-tab",
      });

      expect(response.statusCode).toBe(200);
      expect(response.body).toStrictEqual({ ok: true, targetId: "geo-tab" });
      expect(profileCtx.ensureTabAvailable).toHaveBeenCalledWith("geo-tab", {
        allowPlaywrightFallback: true,
        signal: expect.any(AbortSignal),
        timeoutMs: 5_000,
      });
      expect(pwMocks.setGeolocationViaPlaywright).toHaveBeenCalledWith(
        expect.objectContaining({
          cdpUrl: "http://127.0.0.1:18800",
          targetId: "geo-tab",
          clear: true,
        }),
      );
    });
  });
});
