import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { resolveAdp } from "./src/adp-resolver.js";
import { DiscoveryCache } from "./src/cache.js";
import { extractDomain } from "./src/domain-extractor.js";
import {
  DEFAULT_RESOLVER_CONFIG,
  type DiscoveryResult,
  type ResolverConfig,
} from "./src/types.js";

interface PluginConfig {
  enabled?: boolean;
  cacheTtlSeconds?: number;
  requestTimeoutMs?: number;
  maxBodyBytes?: number;
  logCapabilitySignals?: boolean;
}

export default definePluginEntry({
  id: "discovery-verification",
  name: "Discovery & Verification",
  description:
    "Fetches structured capability metadata from /.well-known/agent-discovery.json before tool calls to external domains and surfaces capability signals into the tool call log.",
  register(api) {
    const raw = ((api.pluginConfig as PluginConfig | undefined) ?? {}) as PluginConfig;
    const enabled = raw.enabled !== false; // default: on
    if (!enabled) {
      api.logger.info?.(
        "[discovery-verification] disabled via plugin config; skipping registration",
      );
      return;
    }

    const resolverConfig: ResolverConfig = {
      cacheTtlSeconds: raw.cacheTtlSeconds ?? DEFAULT_RESOLVER_CONFIG.cacheTtlSeconds,
      requestTimeoutMs: raw.requestTimeoutMs ?? DEFAULT_RESOLVER_CONFIG.requestTimeoutMs,
      maxBodyBytes: raw.maxBodyBytes ?? DEFAULT_RESOLVER_CONFIG.maxBodyBytes,
    };
    const logSignals = raw.logCapabilitySignals !== false;

    const cache = new DiscoveryCache(resolverConfig.cacheTtlSeconds * 1000);

    api.on("before_tool_call", async (event, ctx) => {
      // The plugin must NEVER block a tool call. The first commit only
      // surfaces signals into the log -- block/allow semantics are a
      // future commit, gated by spec convergence and a config flag.
      try {
        const domain = extractDomain(event.toolName, event.params);
        if (!domain) return undefined;

        const cached = cache.get(domain);
        if (cached) {
          if (cached.kind === "positive" && logSignals) {
            logSignal(api, ctx, cached.result, "cache-hit");
          }
          return undefined;
        }

        const outcome = await resolveAdp({
          domain,
          config: resolverConfig,
        });

        if (outcome.kind === "ok") {
          cache.setPositive(domain, outcome.result);
          if (logSignals) logSignal(api, ctx, outcome.result, "fetched");
        } else if (outcome.kind === "not-found") {
          cache.setNegative(domain);
          // Authoritative miss is informational; not logged at info.
          api.logger.debug?.(
            `[discovery-verification] no manifest at ${domain} (404/410)`,
          );
        } else {
          // Transient: don't cache, debug-log only.
          api.logger.debug?.(
            `[discovery-verification] transient at ${domain}: ${outcome.reason}`,
          );
        }
      } catch (err) {
        // Defensive: a hook that throws would fail the tool call closed.
        // We always swallow and continue.
        api.logger.warn?.(
          `[discovery-verification] handler crashed: ${describeError(err)}`,
        );
      }
      return undefined;
    });
  },
});

function logSignal(
  api: { logger: { info?: (msg: string) => void } },
  ctx: { toolName: string; toolCallId?: string; agentId?: string },
  result: DiscoveryResult,
  source: "fetched" | "cache-hit",
): void {
  const services = result.services.map((s) => s.name).join(", ") || "(none declared)";
  const trustHint = result.trust ? " trust:declared" : "";
  api.logger.info?.(
    `[discovery-verification] ${source} ${result.format}/${result.version || "?"} ` +
      `domain=${result.domain} tool=${ctx.toolName} services=[${services}]${trustHint}`,
  );
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
