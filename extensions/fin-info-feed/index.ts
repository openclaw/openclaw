import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openfinclaw/plugin-sdk";
import { scanAllKols, type KolNewsItem, type ScanResult } from "./src/grok-client.js";
import { NewsStore } from "./src/news-store.js";

const json = (payload: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
  details: payload,
});

// ── Config types ─────────────────────────────────────────────────

type InfoFeedConfig = {
  mode: "stub" | "live" | "grok";
  apiKey?: string;
  endpoint?: string;
  requestTimeoutMs: number;
  grok: GrokConfig;
};

type GrokConfig = {
  apiKey?: string;
  model: string;
  defaultHandles: string[];
  scanTopic?: string;
  scanIntervalMs: number;
  urgentThreshold: number;
  digestMinScore: number;
  autoScan: boolean;
  runOnStart: boolean;
};

// ── Env helpers ──────────────────────────────────────────────────

function readEnv(keys: string[]): string | undefined {
  for (const key of keys) {
    const value = process.env[key]?.trim();
    if (value) return value;
  }
  return undefined;
}

function parseBool(value: string | undefined, defaultValue: boolean): boolean {
  if (value == null) return defaultValue;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return defaultValue;
}

function parseHandles(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((h) => h.trim().replace(/^@/, "").toLowerCase())
    .filter(Boolean);
}

// ── Config resolution ────────────────────────────────────────────

function resolveConfig(api: OpenClawPluginApi): InfoFeedConfig {
  const raw = api.pluginConfig as Record<string, unknown> | undefined;
  const grokRaw = (raw?.grok as Record<string, unknown>) ?? {};

  const modeRaw =
    (typeof raw?.mode === "string" ? raw.mode : undefined) ??
    readEnv(["OPENFINCLAW_FIN_INFO_MODE", "FIN_INFO_FEED_MODE"]);
  const timeoutRaw =
    raw?.requestTimeoutMs ??
    readEnv(["OPENFINCLAW_FIN_INFO_TIMEOUT_MS", "FIN_INFO_FEED_TIMEOUT_MS"]);
  const timeout = Number(timeoutRaw);

  // Grok API key: plugin config > OPENFINCLAW_XAI_API_KEY > XAI_API_KEY
  const grokApiKey =
    (typeof grokRaw.apiKey === "string" ? grokRaw.apiKey : undefined) ??
    readEnv(["OPENFINCLAW_XAI_API_KEY", "XAI_API_KEY"]);

  const grokModel =
    (typeof grokRaw.model === "string" ? grokRaw.model : undefined) ??
    readEnv(["OPENFINCLAW_FIN_INFO_GROK_MODEL"]) ??
    "grok-4-1-fast";

  const defaultHandlesRaw =
    (typeof grokRaw.defaultHandles === "string" ? grokRaw.defaultHandles : undefined) ??
    readEnv(["OPENFINCLAW_FIN_INFO_KOL_HANDLES"]);

  const scanTopic =
    (typeof grokRaw.scanTopic === "string" ? grokRaw.scanTopic : undefined) ??
    readEnv(["OPENFINCLAW_FIN_INFO_SCAN_TOPIC"]);

  const intervalRaw = grokRaw.scanIntervalMs ?? readEnv(["OPENFINCLAW_FIN_INFO_SCAN_INTERVAL_MS"]);
  const interval = Number(intervalRaw);

  const urgentRaw = grokRaw.urgentThreshold ?? readEnv(["OPENFINCLAW_FIN_INFO_URGENT_THRESHOLD"]);
  const urgent = Number(urgentRaw);

  const digestMinRaw = grokRaw.digestMinScore ?? readEnv(["OPENFINCLAW_FIN_INFO_DIGEST_MIN_SCORE"]);
  const digestMin = Number(digestMinRaw);

  const autoScanRaw =
    typeof grokRaw.autoScan === "boolean"
      ? String(grokRaw.autoScan)
      : readEnv(["OPENFINCLAW_FIN_INFO_AUTO_SCAN"]);

  const runOnStartRaw =
    typeof grokRaw.runOnStart === "boolean"
      ? String(grokRaw.runOnStart)
      : readEnv(["OPENFINCLAW_FIN_INFO_RUN_ON_START"]);

  const mode = (["stub", "live", "grok"] as const).includes(modeRaw as "stub" | "live" | "grok")
    ? (modeRaw as "stub" | "live" | "grok")
    : "stub";

  return {
    mode,
    apiKey:
      (typeof raw?.apiKey === "string" ? raw.apiKey : undefined) ??
      readEnv(["OPENFINCLAW_FIN_INFO_API_KEY", "FIN_INFO_FEED_API_KEY"]),
    endpoint:
      (typeof raw?.endpoint === "string" ? raw.endpoint : undefined) ??
      readEnv(["OPENFINCLAW_FIN_INFO_ENDPOINT", "FIN_INFO_FEED_ENDPOINT"]),
    requestTimeoutMs: Number.isFinite(timeout) && timeout >= 1000 ? Math.floor(timeout) : 15_000,
    grok: {
      apiKey: grokApiKey,
      model: grokModel,
      defaultHandles: parseHandles(defaultHandlesRaw),
      scanTopic,
      scanIntervalMs: Number.isFinite(interval) && interval >= 60_000 ? Math.floor(interval) : 900_000,
      urgentThreshold: Number.isFinite(urgent) && urgent >= 1 && urgent <= 10 ? Math.floor(urgent) : 9,
      digestMinScore: Number.isFinite(digestMin) && digestMin >= 1 && digestMin <= 10 ? Math.floor(digestMin) : 5,
      autoScan: parseBool(autoScanRaw, true),
      runOnStart: parseBool(runOnStartRaw, true),
    },
  };
}

// ── Live mode HTTP helper ────────────────────────────────────────

async function feedRequest(
  config: InfoFeedConfig,
  path: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (config.mode === "stub") {
    return {
      status: "stub",
      mode: "stub",
      path,
      body,
      message:
        "Info Feed running in stub mode. Set fin-info-feed.mode=live to call the real backend.",
    };
  }

  if (!config.apiKey) {
    throw new Error("Info Feed API key not configured. Set fin-info-feed.apiKey in plugin config.");
  }
  if (!config.endpoint) {
    throw new Error(
      "Info Feed endpoint not configured. Set fin-info-feed.endpoint in plugin config.",
    );
  }

  const url = new URL(path, config.endpoint).toString();
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(config.requestTimeoutMs),
  });

  const raw = await response.text();
  let payload: unknown = {};
  if (raw) {
    try {
      payload = JSON.parse(raw);
    } catch {
      payload = { raw };
    }
  }

  if (!response.ok) {
    const message =
      (payload as { error?: unknown; message?: unknown })?.error ??
      (payload as { error?: unknown; message?: unknown })?.message ??
      raw;
    throw new Error(`Info Feed API error (${response.status}): ${String(message).slice(0, 240)}`);
  }

  return {
    status: "ok",
    mode: "live",
    endpoint: url,
    data: payload,
  };
}

// ── Grok scanner service ─────────────────────────────────────────

function createScannerService(
  config: InfoFeedConfig,
  store: NewsStore,
  logger: { info(...args: unknown[]): void; warn(...args: unknown[]): void; error(...args: unknown[]): void },
) {
  let timer: ReturnType<typeof setInterval> | null = null;
  let scanning = false;

  async function runScan(): Promise<ScanResult | null> {
    if (scanning) return null;
    if (!config.grok.apiKey) {
      logger.warn("[fin-info-feed] Grok API key not set, skipping scan");
      return null;
    }

    scanning = true;
    const scanId = store.startScan();

    try {
      // Merge default handles + DB subscriptions
      const subs = store.getActiveSubscriptions();
      const subHandles = subs.map((s) => s.handle);
      const allHandles = [...new Set([...config.grok.defaultHandles, ...subHandles])];

      if (allHandles.length === 0) {
        store.completeScan(scanId, 0);
        scanning = false;
        return { items: [], batchCount: 0, totalHandles: 0, scannedAt: new Date().toISOString() };
      }

      // fromDate = last scan time or 24h ago
      const lastScan = store.getLastScanTime();
      const fromDate = lastScan ?? new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

      const result = await scanAllKols({
        apiKey: config.grok.apiKey,
        model: config.grok.model,
        handles: allHandles,
        topic: config.grok.scanTopic,
        fromDate: fromDate.split("T")[0], // YYYY-MM-DD format for xAI
        timeoutMs: config.requestTimeoutMs,
      });

      const inserted = store.insertItems(result.items);
      store.completeScan(scanId, inserted);
      logger.info(`[fin-info-feed] Scan complete: ${inserted} new items from ${result.totalHandles} handles`);
      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      store.failScan(scanId, msg);
      logger.error(`[fin-info-feed] Scan failed: ${msg}`);
      return null;
    } finally {
      scanning = false;
    }
  }

  return {
    start() {
      if (config.grok.runOnStart) {
        // Defer initial scan slightly to avoid blocking startup
        setTimeout(() => void runScan(), 2000);
      }
      if (config.grok.autoScan) {
        timer = setInterval(() => void runScan(), config.grok.scanIntervalMs);
      }
    },
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      store.close();
    },
    triggerNow: runScan,
    getStore: () => store,
  };
}

// ── Digest helpers ───────────────────────────────────────────────

function getDigestSince(period: string): string {
  const now = Date.now();
  switch (period) {
    case "morning": {
      // Items from last 12 hours (overnight)
      return new Date(now - 12 * 60 * 60 * 1000).toISOString();
    }
    case "evening": {
      // Items from today (last 12 hours)
      return new Date(now - 12 * 60 * 60 * 1000).toISOString();
    }
    case "weekly": {
      return new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString();
    }
    default: {
      // 24h fallback
      return new Date(now - 24 * 60 * 60 * 1000).toISOString();
    }
  }
}

// ── Plugin definition ────────────────────────────────────────────

const finInfoFeedPlugin = {
  id: "fin-info-feed",
  name: "Info Feed",
  description:
    "Intelligent financial information streaming — news search, subscriptions, and digests",
  kind: "financial" as const,

  register(api: OpenClawPluginApi) {
    const config = resolveConfig(api);
    const logger = api.logger ?? { info() {}, warn() {}, error() {}, debug() {} };

    // Grok mode: initialize SQLite store + scanner service
    let store: NewsStore | null = null;
    let scanner: ReturnType<typeof createScannerService> | null = null;

    if (config.mode === "grok") {
      const dbPath = api.resolvePath("state/fin-news.sqlite");
      store = new NewsStore(dbPath);
      scanner = createScannerService(config, store, logger);

      api.registerService({
        id: "fin-info-feed-scanner",
        start: () => scanner!.start(),
        stop: () => scanner!.stop(),
        instance: { triggerNow: scanner.triggerNow, getStore: scanner.getStore },
      } as Parameters<typeof api.registerService>[0]);
    }

    // ---------------------------------------------------------------
    // Tool 1: fin_info_search
    // ---------------------------------------------------------------
    api.registerTool(
      {
        name: "fin_info_search",
        label: "Info Search",
        description:
          config.mode === "grok"
            ? "Search KOL posts on X/Twitter via Grok x_search. Optionally specify handles to scan."
            : "Search financial news and information.",
        parameters: Type.Object({
          query: Type.String({ description: "Search query for financial news and information" }),
          symbols: Type.Optional(
            Type.Array(Type.String(), { description: "Filter by asset symbols" }),
          ),
          timeRange: Type.Optional(
            Type.Unsafe<"1h" | "24h" | "7d" | "30d">({
              type: "string",
              enum: ["1h", "24h", "7d", "30d"],
            }),
          ),
          limit: Type.Optional(Type.Number({ description: "Maximum number of results to return" })),
          handles: Type.Optional(
            Type.Array(Type.String(), {
              description: "(grok mode) Specific X handles to search (max 25)",
            }),
          ),
        }),
        async execute(_toolCallId: string, params: Record<string, unknown>) {
          try {
            const query = String(params.query ?? "").trim();
            if (!query) throw new Error("query is required");

            // ── Grok mode ──
            if (config.mode === "grok") {
              if (!config.grok.apiKey) {
                throw new Error("xAI API key not configured. Set XAI_API_KEY or grok.apiKey.");
              }

              const handles = Array.isArray(params.handles)
                ? (params.handles as string[])
                : config.grok.defaultHandles;

              if (handles.length === 0) {
                throw new Error(
                  "No handles specified. Provide handles parameter or set grok.defaultHandles.",
                );
              }

              const result = await scanAllKols({
                apiKey: config.grok.apiKey,
                model: config.grok.model,
                handles,
                topic: query,
                timeoutMs: config.requestTimeoutMs,
              });

              // Persist to SQLite
              if (store) {
                store.insertItems(result.items);
              }

              // Apply limit
              const limit = typeof params.limit === "number" ? params.limit : 20;
              const items = result.items.slice(0, limit);

              return json({
                success: true,
                mode: "grok",
                results: {
                  items,
                  totalFound: result.items.length,
                  batchCount: result.batchCount,
                  totalHandles: result.totalHandles,
                },
              });
            }

            // ── Stub / Live mode ──
            const result = await feedRequest(config, "/v1/search", {
              query,
              symbols: Array.isArray(params.symbols) ? params.symbols : undefined,
              timeRange: typeof params.timeRange === "string" ? params.timeRange : undefined,
              limit: typeof params.limit === "number" ? params.limit : 20,
            });

            return json({ success: true, results: result });
          } catch (err) {
            return json({ error: err instanceof Error ? err.message : String(err) });
          }
        },
      },
      { names: ["fin_info_search"] },
    );

    // ---------------------------------------------------------------
    // Tool 2: fin_info_subscribe
    // ---------------------------------------------------------------
    api.registerTool(
      {
        name: "fin_info_subscribe",
        label: "Info Subscribe",
        description:
          config.mode === "grok"
            ? "Manage KOL subscriptions — add/remove/list X handles for monitoring."
            : "Subscribe to information feed for specific topics or assets.",
        parameters: Type.Object({
          topics: Type.Optional(
            Type.Array(Type.String(), { description: "Topics to subscribe to (stub/live mode)" }),
          ),
          symbols: Type.Optional(
            Type.Array(Type.String(), { description: "Asset symbols to track" }),
          ),
          priority: Type.Optional(
            Type.Unsafe<"low" | "medium" | "high" | "critical">({
              type: "string",
              enum: ["low", "medium", "high", "critical"],
            }),
          ),
          handles: Type.Optional(
            Type.Array(Type.String(), {
              description: "(grok mode) X handles to add/remove",
            }),
          ),
          action: Type.Optional(
            Type.Unsafe<"add" | "remove" | "list">({
              type: "string",
              enum: ["add", "remove", "list"],
              description: "(grok mode) Subscription action",
            }),
          ),
        }),
        async execute(_toolCallId: string, params: Record<string, unknown>) {
          try {
            // ── Grok mode ──
            if (config.mode === "grok") {
              if (!store) throw new Error("News store not initialized");

              const action = String(params.action ?? "list").trim();
              const handles = Array.isArray(params.handles) ? (params.handles as string[]) : [];
              const priority = (params.priority as "low" | "medium" | "high" | "critical") ?? "medium";

              if (action === "add") {
                if (handles.length === 0) throw new Error("handles required for add action");
                for (const h of handles) store.addSubscription(h, priority);
                return json({
                  success: true,
                  mode: "grok",
                  action: "add",
                  added: handles,
                  priority,
                  subscriptions: store.getActiveSubscriptions(),
                });
              }

              if (action === "remove") {
                if (handles.length === 0) throw new Error("handles required for remove action");
                for (const h of handles) store.removeSubscription(h);
                return json({
                  success: true,
                  mode: "grok",
                  action: "remove",
                  removed: handles,
                  subscriptions: store.getActiveSubscriptions(),
                });
              }

              // action === "list"
              return json({
                success: true,
                mode: "grok",
                action: "list",
                subscriptions: store.getActiveSubscriptions(),
                defaultHandles: config.grok.defaultHandles,
              });
            }

            // ── Stub / Live mode ──
            const topics = Array.isArray(params.topics) ? (params.topics as string[]) : [];
            if (topics.length === 0) throw new Error("at least one topic is required");
            const priority = String(params.priority ?? "medium").trim();

            const result = await feedRequest(config, "/v1/subscribe", {
              topics,
              symbols: Array.isArray(params.symbols) ? params.symbols : undefined,
              priority,
            });

            return json({ success: true, subscription: result });
          } catch (err) {
            return json({ error: err instanceof Error ? err.message : String(err) });
          }
        },
      },
      { names: ["fin_info_subscribe"] },
    );

    // ---------------------------------------------------------------
    // Tool 3: fin_info_digest
    // ---------------------------------------------------------------
    api.registerTool(
      {
        name: "fin_info_digest",
        label: "Info Digest",
        description:
          config.mode === "grok"
            ? "Generate KOL intelligence digest. period=urgent returns high-score unpushed items for immediate push."
            : "Generate a personalized news digest.",
        parameters: Type.Object({
          period: Type.Unsafe<"morning" | "evening" | "weekly" | "urgent">({
            type: "string",
            enum: ["morning", "evening", "weekly", "urgent"],
          }),
          includePortfolio: Type.Optional(
            Type.Boolean({
              description: "Include portfolio-related news (default: true)",
              default: true,
            }),
          ),
          markPushed: Type.Optional(
            Type.Boolean({
              description: "(grok mode) Mark returned items as pushed (default: true for urgent)",
              default: true,
            }),
          ),
        }),
        async execute(_toolCallId: string, params: Record<string, unknown>) {
          try {
            const period = String(params.period ?? "").trim();
            if (!period) throw new Error("period is required");

            // ── Grok mode ──
            if (config.mode === "grok") {
              if (!store) throw new Error("News store not initialized");

              if (period === "urgent") {
                const items = store.getUrgentUnpushed(config.grok.urgentThreshold);
                const shouldMarkPushed = params.markPushed !== false;
                if (shouldMarkPushed && items.length > 0) {
                  store.markPushed(items.map((i) => i.id));
                }
                return json({
                  success: true,
                  mode: "grok",
                  period: "urgent",
                  threshold: config.grok.urgentThreshold,
                  items,
                  count: items.length,
                  pushed: shouldMarkPushed,
                });
              }

              // morning / evening / weekly digest
              const since = getDigestSince(period);
              const items = store.getItemsSince(since, config.grok.digestMinScore);
              const stats = store.getStats(since);

              const shouldMarkPushed = params.markPushed !== false;
              if (shouldMarkPushed && items.length > 0) {
                store.markDigestIncluded(items.map((i) => i.id));
              }

              return json({
                success: true,
                mode: "grok",
                period,
                since,
                items,
                count: items.length,
                stats,
              });
            }

            // ── Stub / Live mode ──
            const includePortfolio =
              typeof params.includePortfolio === "boolean" ? params.includePortfolio : true;

            const result = await feedRequest(config, "/v1/digest", {
              period,
              includePortfolio,
            });

            return json({ success: true, digest: result });
          } catch (err) {
            return json({ error: err instanceof Error ? err.message : String(err) });
          }
        },
      },
      { names: ["fin_info_digest"] },
    );
  },
};

export default finInfoFeedPlugin;
