import type { Mock } from "vitest";
import { afterEach, beforeEach, vi } from "vitest";
import { _setFetchGuardForTesting } from "./types.js";

export const BLUE_BUBBLES_PRIVATE_API_STATUS = {
  enabled: true,
  disabled: false,
  unknown: null,
} as const;

type BlueBubblesPrivateApiStatusMock = {
  mockReturnValue: (value: boolean | null) => unknown;
  mockReturnValueOnce: (value: boolean | null) => unknown;
};

export function mockBlueBubblesPrivateApiStatus(
  mock: Pick<BlueBubblesPrivateApiStatusMock, "mockReturnValue">,
  value: boolean | null,
) {
  mock.mockReturnValue(value);
}

export function mockBlueBubblesPrivateApiStatusOnce(
  mock: Pick<BlueBubblesPrivateApiStatusMock, "mockReturnValueOnce">,
  value: boolean | null,
) {
  mock.mockReturnValueOnce(value);
}

export function resolveBlueBubblesAccountFromConfig(params: {
  cfg?: { channels?: { bluebubbles?: Record<string, unknown> } };
  accountId?: string;
}) {
  const config = params.cfg?.channels?.bluebubbles ?? {};
  return {
    accountId: params.accountId ?? "default",
    enabled: config.enabled !== false,
    configured: Boolean(config.serverUrl && config.password),
    config,
  };
}

export function createBlueBubblesAccountsMockModule() {
  return {
    resolveBlueBubblesAccount: vi.fn(resolveBlueBubblesAccountFromConfig),
  };
}

type BlueBubblesProbeMockModule = {
  getCachedBlueBubblesPrivateApiStatus: Mock<() => boolean | null>;
  isBlueBubblesPrivateApiStatusEnabled: Mock<(status: boolean | null) => boolean>;
};

export function createBlueBubblesProbeMockModule(): BlueBubblesProbeMockModule {
  return {
    getCachedBlueBubblesPrivateApiStatus: vi
      .fn()
      .mockReturnValue(BLUE_BUBBLES_PRIVATE_API_STATUS.unknown),
    isBlueBubblesPrivateApiStatusEnabled: vi.fn((status: boolean | null) => status === true),
  };
}

export function installBlueBubblesFetchTestHooks(params: {
  mockFetch: ReturnType<typeof vi.fn>;
  privateApiStatusMock: {
    mockReset?: () => unknown;
    mockClear?: () => unknown;
    mockReturnValue: (value: boolean | null) => unknown;
  };
}) {
  beforeEach(() => {
    vi.stubGlobal("fetch", params.mockFetch);
    // Replace the SSRF guard with a passthrough that delegates to the mocked global.fetch,
    // wrapping the result in a real Response so callers can call .arrayBuffer() on it.
    _setFetchGuardForTesting(async (p) => {
      const raw = await globalThis.fetch(p.url, p.init);
      let body: ArrayBuffer;
      if (typeof raw.arrayBuffer === "function") {
        body = await raw.arrayBuffer();
      } else {
        const text =
          typeof (raw as { text?: () => Promise<string> }).text === "function"
            ? await (raw as { text: () => Promise<string> }).text()
            : typeof (raw as { json?: () => Promise<unknown> }).json === "function"
              ? JSON.stringify(await (raw as { json: () => Promise<unknown> }).json())
              : "";
        body = new TextEncoder().encode(text).buffer;
      }
      return {
        response: new Response(body, {
          status: (raw as { status?: number }).status ?? 200,
          headers: (raw as { headers?: HeadersInit }).headers,
        }),
        release: async () => {},
        finalUrl: p.url,
      };
    });
    params.mockFetch.mockReset();
    params.privateApiStatusMock.mockReset?.();
    params.privateApiStatusMock.mockClear?.();
    params.privateApiStatusMock.mockReturnValue(BLUE_BUBBLES_PRIVATE_API_STATUS.unknown);
  });

  afterEach(() => {
    _setFetchGuardForTesting(null);
    vi.unstubAllGlobals();
  });
}
