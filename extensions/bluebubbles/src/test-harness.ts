import { isBlockedHostnameOrIp } from "openclaw/plugin-sdk/ssrf-runtime";
import type { Mock } from "vitest";
import { afterEach, beforeEach, vi } from "vitest";
import { _setFetchGuardForTesting, normalizeBlueBubblesServerUrl } from "./types.js";

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

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function normalizeBlueBubblesPrivateNetworkAliases(
  config: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  const record = asRecord(config);
  if (!record) {
    return config;
  }
  const network = asRecord(record.network);
  const canonicalValue =
    typeof network?.dangerouslyAllowPrivateNetwork === "boolean"
      ? network.dangerouslyAllowPrivateNetwork
      : typeof network?.allowPrivateNetwork === "boolean"
        ? network.allowPrivateNetwork
        : typeof record.dangerouslyAllowPrivateNetwork === "boolean"
          ? record.dangerouslyAllowPrivateNetwork
          : typeof record.allowPrivateNetwork === "boolean"
            ? record.allowPrivateNetwork
            : undefined;

  if (canonicalValue === undefined) {
    return config;
  }

  const {
    allowPrivateNetwork: _legacyFlatAllow,
    dangerouslyAllowPrivateNetwork: _legacyFlatDanger,
    ...rest
  } = record;
  const {
    allowPrivateNetwork: _legacyNetworkAllow,
    dangerouslyAllowPrivateNetwork: _legacyNetworkDanger,
    ...restNetwork
  } = network ?? {};

  return {
    ...rest,
    network: {
      ...restNetwork,
      dangerouslyAllowPrivateNetwork: canonicalValue,
    },
  };
}

function normalizeBlueBubblesAccountsMap(
  accounts: Record<string, Record<string, unknown> | undefined> | undefined,
): Record<string, Record<string, unknown> | undefined> | undefined {
  if (!accounts) {
    return undefined;
  }
  return Object.fromEntries(
    Object.entries(accounts).map(([accountKey, accountConfig]) => [
      accountKey,
      normalizeBlueBubblesPrivateNetworkAliases(accountConfig),
    ]),
  );
}

export function resolveBlueBubblesAccountFromConfig(params: {
  cfg?: { channels?: { bluebubbles?: Record<string, unknown> } };
  accountId?: string;
}) {
  const baseConfig =
    normalizeBlueBubblesPrivateNetworkAliases(params.cfg?.channels?.bluebubbles ?? {}) ?? {};
  const accounts = normalizeBlueBubblesAccountsMap(
    baseConfig.accounts as Record<string, Record<string, unknown> | undefined> | undefined,
  );
  const accountId = params.accountId ?? "default";
  const accountConfig =
    normalizeBlueBubblesPrivateNetworkAliases(accounts?.[accountId] ?? {}) ?? {};
  const config: Record<string, unknown> = {
    ...baseConfig,
    ...accountConfig,
    network:
      typeof baseConfig.network === "object" &&
      baseConfig.network &&
      !Array.isArray(baseConfig.network) &&
      typeof accountConfig.network === "object" &&
      accountConfig.network &&
      !Array.isArray(accountConfig.network)
        ? {
            ...(baseConfig.network as Record<string, unknown>),
            ...(accountConfig.network as Record<string, unknown>),
          }
        : (accountConfig.network ?? baseConfig.network),
  };
  return {
    accountId,
    enabled: config.enabled !== false,
    configured: Boolean(config.serverUrl && config.password),
    config,
  };
}

function resolveBlueBubblesPrivateNetworkConfigValueFromConfig(
  config: Record<string, unknown> | undefined,
): boolean | undefined {
  const record = asRecord(config);
  if (!record) {
    return undefined;
  }
  const network = asRecord(record.network);
  if (typeof network?.dangerouslyAllowPrivateNetwork === "boolean") {
    return network.dangerouslyAllowPrivateNetwork;
  }
  if (typeof network?.allowPrivateNetwork === "boolean") {
    return network.allowPrivateNetwork;
  }
  if (typeof record.dangerouslyAllowPrivateNetwork === "boolean") {
    return record.dangerouslyAllowPrivateNetwork;
  }
  if (typeof record.allowPrivateNetwork === "boolean") {
    return record.allowPrivateNetwork;
  }
  return undefined;
}

function resolveBlueBubblesEffectiveAllowPrivateNetworkFromConfig(params: {
  baseUrl?: string;
  config?: Record<string, unknown>;
}) {
  const configuredValue = resolveBlueBubblesPrivateNetworkConfigValueFromConfig(params.config);
  if (configuredValue !== undefined) {
    return configuredValue;
  }
  if (!params.baseUrl) {
    return false;
  }
  try {
    const hostname = new URL(normalizeBlueBubblesServerUrl(params.baseUrl)).hostname.trim();
    return Boolean(hostname) && isBlockedHostnameOrIp(hostname);
  } catch {
    return false;
  }
}

export function createBlueBubblesAccountsMockModule() {
  return {
    resolveBlueBubblesAccount: vi.fn(resolveBlueBubblesAccountFromConfig),
    resolveBlueBubblesEffectiveAllowPrivateNetwork: vi.fn(
      resolveBlueBubblesEffectiveAllowPrivateNetworkFromConfig,
    ),
    resolveBlueBubblesPrivateNetworkConfigValue: vi.fn(
      resolveBlueBubblesPrivateNetworkConfigValueFromConfig,
    ),
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
  const setFetchGuardPassthrough = createBlueBubblesFetchGuardPassthroughInstaller();
  beforeEach(() => {
    vi.stubGlobal("fetch", params.mockFetch);
    // Replace the SSRF guard with a passthrough that delegates to the mocked global.fetch,
    // wrapping the result in a real Response so callers can call .arrayBuffer() on it.
    setFetchGuardPassthrough();
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

export function createBlueBubblesFetchGuardPassthroughInstaller() {
  return (capturePolicy?: (policy: unknown) => void) => {
    _setFetchGuardForTesting(async (params) => {
      capturePolicy?.(params.policy);
      const raw = await globalThis.fetch(params.url, params.init);
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
        finalUrl: params.url,
      };
    });
  };
}
