export type GesahniConfig = {
  bridge?: {
    baseUrl?: string;
    readBridgeToken?: string;
    writeBridgeToken?: string;
    defaultTimeoutMs?: number;
    userId?: string;
  };
  marketData?: {
    provider?: "alpaca";
    alpaca?: {
      baseUrl?: string;
      keyId?: string;
      secretKey?: string;
      stockFeed?: string;
      optionFeed?: string;
    };
  };
  alerts?: {
    groupChannelId?: string;
    groupChannelName?: string;
    groupCreation?: "anyone" | "owner";
    pollSeconds?: number;
    cooldownSeconds?: number;
  };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asPositiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function resolveConfigString(value: unknown, ...envNames: string[]): string | undefined {
  const configured = asString(value);
  if (configured) {
    const envRef = /^\$\{([A-Z0-9_]+)\}$/.exec(configured);
    if (!envRef) {
      return configured;
    }
    const resolved = process.env[envRef[1]]?.trim();
    if (resolved) {
      return resolved;
    }
  }
  for (const envName of envNames) {
    const resolved = process.env[envName]?.trim();
    if (resolved) {
      return resolved;
    }
  }
  return undefined;
}

export function readGesahniConfig(raw: unknown): GesahniConfig {
  if (!isRecord(raw)) {
    raw = {};
  }
  const record = raw as Record<string, unknown>;
  const bridgeRaw = isRecord(record.bridge) ? { ...record, ...record.bridge } : record;
  const marketDataRaw = isRecord(record.marketData) ? record.marketData : {};
  const alpacaRaw = isRecord(marketDataRaw.alpaca) ? marketDataRaw.alpaca : {};
  const alertsRaw = isRecord(record.alerts) ? record.alerts : {};
  const envTimeout = Number(process.env.GESAHNI_DEFAULT_TIMEOUT_MS);
  return {
    bridge: {
      baseUrl: resolveConfigString(bridgeRaw.baseUrl, "GESAHNI_BASE_URL"),
      readBridgeToken: resolveConfigString(bridgeRaw.readBridgeToken, "GESAHNI_READ_BRIDGE_TOKEN"),
      writeBridgeToken: resolveConfigString(
        bridgeRaw.writeBridgeToken,
        "GESAHNI_WRITE_BRIDGE_TOKEN",
      ),
      defaultTimeoutMs:
        asPositiveNumber(bridgeRaw.defaultTimeoutMs) ??
        (Number.isFinite(envTimeout) && envTimeout > 0 ? envTimeout : 2500),
      userId: resolveConfigString(
        bridgeRaw.userId,
        "GESAHNI_BRIDGE_USER_ID",
        "GESAHNI_TEST_CHAT_ID",
      ),
    },
    marketData: {
      provider: marketDataRaw.provider === "alpaca" ? "alpaca" : undefined,
      alpaca: {
        baseUrl: asString(alpacaRaw.baseUrl),
        keyId: asString(alpacaRaw.keyId),
        secretKey: asString(alpacaRaw.secretKey),
        stockFeed: asString(alpacaRaw.stockFeed),
        optionFeed: asString(alpacaRaw.optionFeed),
      },
    },
    alerts: {
      groupChannelId: asString(alertsRaw.groupChannelId),
      groupChannelName: asString(alertsRaw.groupChannelName) ?? "stock-alerts",
      groupCreation: alertsRaw.groupCreation === "owner" ? "owner" : "anyone",
      pollSeconds: asPositiveNumber(alertsRaw.pollSeconds) ?? 30,
      cooldownSeconds: asPositiveNumber(alertsRaw.cooldownSeconds) ?? 300,
    },
  };
}
