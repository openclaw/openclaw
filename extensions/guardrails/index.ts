import { createHash } from "node:crypto";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { resolveSecretRefValues } from "openclaw/plugin-sdk/runtime-secret-resolution";
import { coerceSecretRef, type SecretRef } from "openclaw/plugin-sdk/secret-ref-runtime";
import { createBlacklistBackend } from "./src/builtin-blacklist-connector.js";
import { resolveChannelConfig, resolveConfig } from "./src/config.js";
import type {
  BackendFn,
  BlacklistConfig,
  EffectiveChannelConfig,
  HttpConfig,
  SecretInputValue,
} from "./src/config.js";
import { createGuardrailsHandler } from "./src/handler.js";
import {
  resolveHttpAdapter,
  type GuardrailsProviderAdapter,
  type ResolvedHttpConfig,
} from "./src/http-connector.js";

const plugin = {
  id: "guardrail-bridge",
  name: "Guardrail Bridge",
  description: "Pre-agent guardrail-bridge plugin with blacklist and HTTP connectors.",
  register(api: OpenClawPluginApi) {
    if (api.registrationMode !== "full") {
      return;
    }

    const logger = api.logger;
    const config = resolveConfig(api.pluginConfig);

    // ── Collect per-channel effective configs ──────────────────────────

    const channelIds = Object.keys(config.channels);
    const globalEffective = resolveChannelConfig(config, undefined, logger);

    const channelConfigs = new Map<string, EffectiveChannelConfig>();
    for (const channelId of channelIds) {
      const effective = resolveChannelConfig(config, channelId, logger);
      if (effective.enabled) {
        channelConfigs.set(channelId, effective);
      }
    }

    // Check if anything is enabled at all
    const hasAnyEnabled = globalEffective.enabled || channelConfigs.size > 0;
    if (!hasAnyEnabled) {
      logger.info("guardrail-bridge: no effective connector configured, plugin disabled");
      return;
    }

    // ── Determine which connectors are needed ────────────────────────

    const usedConnectors = new Set<string>();
    if (globalEffective.enabled && globalEffective.connector) {
      usedConnectors.add(globalEffective.connector);
    }
    for (const [, cfg] of channelConfigs) {
      if (cfg.connector) {
        usedConnectors.add(cfg.connector);
      }
    }

    // ── Create connector instances ────────────────────────────────────

    const disposables: Array<() => void> = [];
    function addDisposable(dispose: () => void): void {
      disposables.push(dispose);
    }

    // Blacklist connector: per effective config, deduped by runtime inputs.
    const blacklistBackendEntries = new Map<string, BackendFn>();

    function blacklistBackendKey(blacklist: BlacklistConfig, blockMessage: string): string {
      return createHash("sha256")
        .update(
          stableStringify({
            blacklistFile: blacklist.blacklistFile,
            caseSensitive: blacklist.caseSensitive,
            hot: blacklist.hot,
            hotDebounceMs: blacklist.hotDebounceMs,
            blockMessage,
          }),
        )
        .digest("hex");
    }

    function ensureBlacklistBackend(blacklist: BlacklistConfig, blockMessage: string): void {
      const key = blacklistBackendKey(blacklist, blockMessage);
      if (blacklistBackendEntries.has(key)) {
        return;
      }

      const handle = createBlacklistBackend(blacklist, blockMessage, logger);
      blacklistBackendEntries.set(key, handle.backendFn);
      addDisposable(handle.dispose);
    }

    // HTTP connector: per-provider adapter dedup, per-channel BackendFn.
    const httpAdapterEntries = new Map<
      string,
      {
        adapter: GuardrailsProviderAdapter | null;
        initFailed: boolean;
        initPromise: Promise<void>;
      }
    >();

    function stableStringify(value: unknown): string {
      if (Array.isArray(value)) {
        return `[${value.map((item) => stableStringify(item)).join(",")}]`;
      }
      if (value !== null && typeof value === "object") {
        const record = value as Record<string, unknown>;
        const entries = Object.keys(record)
          .toSorted()
          .filter((key) => record[key] !== undefined)
          .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`);
        return `{${entries.join(",")}}`;
      }
      return JSON.stringify(value);
    }

    // Adapter dedupe deliberately excludes apiKey so that secret never reaches
    // long-lived hash key, and channels sharing non-sensitive HTTP config
    // share one adapter init even when their apiKeys differ.
    function httpAdapterKey(http: HttpConfig): string {
      return createHash("sha256")
        .update(
          stableStringify({
            provider: http.provider,
            apiUrl: http.apiUrl,
            model: http.model,
            params: http.params,
          }),
        )
        .digest("hex");
    }

    function secretRefKey(ref: SecretRef): string {
      return `${ref.source}:${ref.provider}:${ref.id}`;
    }

    async function resolveApiKeyValue(value: SecretInputValue): Promise<string> {
      if (typeof value === "string") {
        return value;
      }
      const ref = coerceSecretRef(value);
      if (!ref) {
        return "";
      }
      const resolved = await resolveSecretRefValues([ref], { config: api.config });
      const resolvedValue = resolved.get(secretRefKey(ref));
      return typeof resolvedValue === "string" ? resolvedValue : "";
    }

    if (usedConnectors.has("blacklist")) {
      if (globalEffective.enabled && globalEffective.connector === "blacklist") {
        ensureBlacklistBackend(globalEffective.blacklist, globalEffective.blockMessage);
      }
      for (const [, cfg] of channelConfigs) {
        if (cfg.connector === "blacklist") {
          ensureBlacklistBackend(cfg.blacklist, cfg.blockMessage);
        }
      }
    }

    function ensureHttpAdapter(http: HttpConfig): void {
      const key = httpAdapterKey(http);
      if (httpAdapterEntries.has(key)) {
        return;
      }

      const entry = {
        adapter: null as GuardrailsProviderAdapter | null,
        initFailed: false,
        initPromise: Promise.resolve(),
      };
      httpAdapterEntries.set(key, entry);

      entry.initPromise = resolveHttpAdapter(http, logger)
        .then((a) => {
          entry.adapter = a;
          logger.info(`guardrail-bridge: HTTP adapter ready (provider: ${http.provider})`);
        })
        .catch((err: unknown) => {
          entry.initFailed = true;
          logger.error(`guardrail-bridge: failed to init HTTP adapter: ${String(err)}`);
        });
    }

    function makeHttpBackendFn(
      http: HttpConfig,
      fallbackOnError: "pass" | "block",
      timeoutMs: number,
    ): BackendFn {
      const key = httpAdapterKey(http);
      const entry = httpAdapterEntries.get(key);
      if (!entry) {
        return async () => ({ action: fallbackOnError });
      }
      // Capture only the non-sensitive HTTP fields in closure. The secret
      // input value is also captured but the plaintext apiKey is rebuilt per
      // check() so it never leaks into long-lived state shared across calls.
      const apiKeyInput = http.apiKey;
      return async (text, context) => {
        if (!entry.adapter && !entry.initFailed) {
          await entry.initPromise;
        }
        if (!entry.adapter) {
          return { action: fallbackOnError };
        }

        let apiKey: string;
        try {
          apiKey = await resolveApiKeyValue(apiKeyInput);
        } catch (err) {
          logger.error(`guardrail-bridge: failed to resolve SecretRef apiKey: ${String(err)}`);
          return { action: fallbackOnError };
        }

        const resolved: ResolvedHttpConfig = {
          provider: http.provider,
          apiKey,
          apiUrl: http.apiUrl,
          model: http.model,
          params: http.params,
        };
        return entry.adapter.check(text, context, resolved, fallbackOnError, timeoutMs);
      };
    }

    if (usedConnectors.has("http")) {
      if (globalEffective.enabled && globalEffective.connector === "http") {
        ensureHttpAdapter(globalEffective.http);
      }
      for (const [, cfg] of channelConfigs) {
        if (cfg.connector === "http") {
          ensureHttpAdapter(cfg.http);
        }
      }
    }

    // ── Resolve backendFn for a given effective config ─────────────────

    function getBackendFn(effective: EffectiveChannelConfig): BackendFn | null {
      if (!effective.enabled || !effective.connector) {
        return null;
      }

      switch (effective.connector) {
        case "blacklist":
          return (
            blacklistBackendEntries.get(
              blacklistBackendKey(effective.blacklist, effective.blockMessage),
            ) ?? null
          );
        case "http":
          return makeHttpBackendFn(effective.http, effective.fallbackOnError, effective.timeoutMs);
        default:
          return null;
      }
    }

    // ── Build per-channel handlers ────────────────────────────────────

    let defaultHandler: ReturnType<typeof createGuardrailsHandler> | null = null;
    if (globalEffective.enabled) {
      const defaultBackendFn = getBackendFn(globalEffective);
      if (defaultBackendFn) {
        defaultHandler = createGuardrailsHandler(defaultBackendFn, globalEffective, logger);
      } else if (globalEffective.connector) {
        logger.error(
          `guardrail-bridge: failed to create default connector "${globalEffective.connector}"`,
        );
      }
    }

    const channelHandlerMap = new Map<string, ReturnType<typeof createGuardrailsHandler>>();
    for (const [channelId, effective] of channelConfigs) {
      const fn = getBackendFn(effective);
      if (!fn) {
        logger.warn(
          `guardrail-bridge: channel "${channelId}" connector "${effective.connector}" not available, skipping`,
        );
        continue;
      }
      channelHandlerMap.set(channelId, createGuardrailsHandler(fn, effective, logger));
    }

    // If no handlers at all, nothing to register
    if (!defaultHandler && channelHandlerMap.size === 0) {
      logger.error("guardrail-bridge: no working connectors, plugin disabled");
      return;
    }

    // ── Register unified hook ─────────────────────────────────────────

    let disposed = false;
    function disposeAll(): void {
      if (disposed) {
        return;
      }
      disposed = true;
      for (const dispose of disposables.splice(0)) {
        try {
          dispose();
        } catch (err) {
          logger.warn(`guardrail-bridge: connector dispose failed: ${String(err)}`);
        }
      }
    }

    api.registerService({
      id: "guardrail-bridge-connectors",
      start() {},
      stop: disposeAll,
    });

    api.on("before_dispatch", async (event, ctx) => {
      const channelId = ctx.channelId ?? event.channel;
      const handler = (channelId && channelHandlerMap.get(channelId)) ?? defaultHandler;
      if (!handler) {
        return { handled: false };
      }
      return handler(event, ctx);
    });

    const parts: string[] = [];
    if (globalEffective.enabled) {
      parts.push(`global connector: ${globalEffective.connector}`);
    }
    if (channelHandlerMap.size > 0) {
      parts.push(`${channelHandlerMap.size} channel handler(s)`);
    }
    logger.info(`guardrail-bridge: plugin registered (${parts.join(", ")})`);
  },
};

export default plugin;
