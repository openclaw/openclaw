import { createHash } from "node:crypto";
import path from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { createBlacklistBackend } from "./src/builtin-blacklist-connector.js";
import { resolveChannelConfig, resolveConfig } from "./src/config.js";
import type {
  BackendFn,
  BlacklistConfig,
  EffectiveChannelConfig,
  HttpConfig,
  ImportConfig,
} from "./src/config.js";
import { createGuardrailsHandler } from "./src/handler.js";
import { resolveHttpAdapter, type GuardrailsProviderAdapter } from "./src/http-connector.js";
import { createImportBackend, type ImportBackendHandle } from "./src/import-connector.js";

const plugin = {
  id: "guardrails",
  name: "Guardrails",
  description: "Pre-agent guardrails plugin with blacklist, HTTP, and import connectors.",
  register(api: OpenClawPluginApi) {
    const config = resolveConfig(api.pluginConfig);
    const logger = api.logger;

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
      logger.info("guardrails: no effective connector configured, plugin disabled");
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

    function httpAdapterKey(http: HttpConfig): string {
      return createHash("sha256")
        .update(
          stableStringify({
            provider: http.provider,
            apiKey: http.apiKey,
            apiUrl: http.apiUrl,
            model: http.model,
            params: http.params,
          }),
        )
        .digest("hex");
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
          logger.info(`guardrails: HTTP adapter ready (provider: ${http.provider})`);
        })
        .catch((err: unknown) => {
          entry.initFailed = true;
          logger.error(`guardrails: failed to init HTTP adapter: ${String(err)}`);
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
      return async (text, context) => {
        if (!entry.adapter && !entry.initFailed) {
          await entry.initPromise;
        }
        if (!entry.adapter) {
          return { action: fallbackOnError };
        }
        return entry.adapter.check(text, context, http, fallbackOnError, timeoutMs);
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

    // Import connector: per-script dedup (supports channel-level different scripts)
    const importEntries = new Map<
      string,
      {
        backendFn: BackendFn | null;
        initFailed: boolean;
        initPromise: Promise<void>;
      }
    >();

    function ensureImportAdapter(importCfg: ImportConfig, effectiveTimeoutMs: number): void {
      const key = importCfg.script;
      if (!key || importEntries.has(key)) {
        return;
      }

      if (!path.isAbsolute(key)) {
        logger.error(
          `guardrails: import script must be an absolute path, got "${key}" — connector disabled`,
        );
        return;
      }

      logger.warn(
        "guardrails: import connector executes TRUSTED LOCAL CODE — verify script path before production use",
      );

      const entry = {
        backendFn: null as BackendFn | null,
        initFailed: false,
        initPromise: Promise.resolve(),
      };

      let importHandle: ImportBackendHandle | null = null;

      entry.initPromise = createImportBackend(
        key,
        importCfg.args,
        importCfg.hot,
        importCfg.hotDebounceMs,
        logger,
      )
        .then((h) => {
          importHandle = h;
          addDisposable(h.dispose);
          // Import scripts are user code — wrap with external timeout via Promise.race.
          // HTTP providers handle their own timeout internally via AbortController.
          entry.backendFn = async (text, context) => {
            let timer: ReturnType<typeof setTimeout> | undefined;
            try {
              return await Promise.race([
                importHandle!.backendFn(text, context),
                new Promise<never>((_, reject) => {
                  timer = setTimeout(
                    () => reject(new Error("guardrails: import connector timeout")),
                    effectiveTimeoutMs,
                  );
                }),
              ]);
            } finally {
              if (timer) {
                clearTimeout(timer);
              }
            }
          };
          logger.info(`guardrails: import connector ready (script: ${key}, hot: ${importCfg.hot})`);
        })
        .catch((err) => {
          entry.initFailed = true;
          logger.error(`guardrails: failed to load import connector: ${err}`);
        });

      importEntries.set(key, entry);
    }

    if (usedConnectors.has("import")) {
      if (globalEffective.enabled && globalEffective.connector === "import") {
        ensureImportAdapter(globalEffective.import, globalEffective.timeoutMs);
      }
      for (const [, cfg] of channelConfigs) {
        if (cfg.connector === "import") {
          ensureImportAdapter(cfg.import, cfg.timeoutMs);
        }
      }
    }

    // ── Resolve backendFn for a given effective config ─────────────────

    function makeImportBackendFn(
      importCfg: ImportConfig,
      fallbackOnError: "pass" | "block",
    ): BackendFn | null {
      const key = importCfg.script;
      const entry = key ? importEntries.get(key) : undefined;
      if (!entry) {
        return null;
      }

      return async (text, context) => {
        if (!entry.backendFn && !entry.initFailed) {
          await entry.initPromise;
        }
        if (!entry.backendFn) {
          if (fallbackOnError === "block") {
            throw new Error("guardrails: import connector not available");
          }
          return { action: "pass" as const };
        }
        return entry.backendFn(text, context);
      };
    }

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
        case "import":
          return makeImportBackendFn(effective.import, effective.fallbackOnError);
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
          `guardrails: failed to create default connector "${globalEffective.connector}"`,
        );
      }
    }

    const channelHandlerMap = new Map<string, ReturnType<typeof createGuardrailsHandler>>();
    for (const [channelId, effective] of channelConfigs) {
      const fn = getBackendFn(effective);
      if (!fn) {
        logger.warn(
          `guardrails: channel "${channelId}" connector "${effective.connector}" not available, skipping`,
        );
        continue;
      }
      channelHandlerMap.set(channelId, createGuardrailsHandler(fn, effective, logger));
    }

    // If no handlers at all, nothing to register
    if (!defaultHandler && channelHandlerMap.size === 0) {
      logger.error("guardrails: no working connectors, plugin disabled");
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
          logger.warn(`guardrails: connector dispose failed: ${String(err)}`);
        }
      }
    }

    api.registerService({
      id: "guardrails-connectors",
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
    logger.info(`guardrails: plugin registered (${parts.join(", ")})`);
  },
};

export default plugin;
