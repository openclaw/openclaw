// Tokenomics service: subscribes to OpenClaw `model.usage` diagnostic events,
// records one ledger row per model call, and serves a spend report over an
// HTTP route. The host-reported `costUsd` is authoritative; when absent the
// pricing catalog estimates the cost (free/zero-cost models stay $0).

import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import {
  type DiagnosticEventMetadata,
  type DiagnosticEventPayload,
  isInternalDiagnosticEventMetadata,
  type OpenClawPluginHttpRouteHandler,
  type OpenClawPluginService,
  type OpenClawPluginServiceContext,
} from "../api.js";
import { buildFinOpsReport, type FinOpsReport } from "./finops.js";
import { HostAdapter, type UsageEvent } from "./host-adapter.js";
import { Ledger } from "./ledger.js";
import { PricingCatalog } from "./pricing.js";
import { renderReport } from "./render.js";
import { buildReport, parseGran, type Gran, type Report } from "./report.js";

type ModelUsageEvent = Extract<DiagnosticEventPayload, { type: "model.usage" }>;

/** Structural subset of `model.usage` consumed by the mapper (test-friendly). */
export interface ModelUsageLike {
  model?: string;
  provider?: string;
  usage?: {
    input?: number;
    output?: number;
    promptTokens?: number;
    total?: number;
  };
  costUsd?: number;
}

const SUBDIR = "tokenomics";
const LEDGER_FILE = "ledger.jsonl";
const PRICING_FILE = "pricing.json";
const DAY_MS = 86_400_000;
const DEFAULT_WINDOW_DAYS = 30;

function numericValue(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * Map an OpenClaw `model.usage` event to a host-neutral {@link UsageEvent}.
 * `costUsd` is forwarded verbatim so the host's billed truth wins; omitting it
 * lets the pricing catalog estimate the cost downstream.
 */
export function toUsageEvent(evt: ModelUsageLike): UsageEvent {
  const usage = evt.usage ?? {};
  // Prefer the host's computed `promptTokens` (input + cacheRead + cacheWrite)
  // so cache-heavy calls are not underreported; fall back to raw `input`.
  const tokensIn = numericValue(usage.promptTokens) ?? numericValue(usage.input) ?? 0;
  const tokensOut = numericValue(usage.output) ?? 0;
  const event: UsageEvent = {
    provider: evt.provider ?? "unknown",
    model: evt.model ?? "unknown",
    tokensIn,
    tokensOut,
  };
  const cost = numericValue(evt.costUsd);
  if (cost !== undefined) {
    event.costUsd = cost;
  }
  return event;
}

function shouldRecord(metadata: DiagnosticEventMetadata): boolean {
  return metadata.trusted || isInternalDiagnosticEventMetadata(metadata);
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

function parseBound(raw: string | null, bound: "since" | "until"): Date | undefined {
  if (!raw) {
    return undefined;
  }
  const t = Date.parse(raw);
  if (Number.isNaN(t)) {
    return undefined;
  }
  // A date-only `until` is an inclusive whole-day bound, so snap it to the end
  // of that UTC day; date-only `since` already parses to start-of-day. Values
  // that carry a time component are honored verbatim.
  if (bound === "until" && DATE_ONLY.test(raw.trim())) {
    return new Date(t + DAY_MS - 1);
  }
  return new Date(t);
}

function safeErrorMessage(err: unknown): string {
  return (err instanceof Error ? (err.message ?? err.name) : String(err)).slice(0, 500);
}

interface Window {
  since: Date;
  until: Date;
}

/**
 * Resolve the `[since, until]` reporting window from query params. Returns a
 * validation error string for params the caller should reject (HTTP 400):
 * unparseable `since`/`until`, or an inverted window.
 */
function resolveWindow(params: URLSearchParams): Window | { error: string } {
  const rawUntil = params.get("until");
  const rawSince = params.get("since");
  const until = parseBound(rawUntil, "until");
  if (rawUntil !== null && rawUntil.trim() !== "" && until === undefined) {
    return { error: "invalid 'until' timestamp" };
  }
  const since = parseBound(rawSince, "since");
  if (rawSince !== null && rawSince.trim() !== "" && since === undefined) {
    return { error: "invalid 'since' timestamp" };
  }
  const resolvedUntil = until ?? new Date();
  const resolvedSince = since ?? new Date(resolvedUntil.getTime() - DEFAULT_WINDOW_DAYS * DAY_MS);
  if (resolvedSince.getTime() > resolvedUntil.getTime()) {
    return { error: "'since' must be on or before 'until'" };
  }
  return { since: resolvedSince, until: resolvedUntil };
}

export function createTokenomicsService() {
  let ledgerPath: string | undefined;
  let pricingPath: string | undefined;
  let adapter: HostAdapter | undefined;
  let unsubscribe: (() => void) | undefined;
  let warn: ((msg: string) => void) | undefined;
  // Count of `model.usage` events that carried no spend signal (no tokens and
  // no host cost). These are not recorded — surfacing the count makes an
  // otherwise-silent capture gap visible (see below).
  let incompleteUsageEvents = 0;

  function recordUsage(evt: ModelUsageEvent): void {
    if (!adapter) {
      return;
    }
    const usageEvent = toUsageEvent(evt);
    // A `model.usage` event with no tokens AND no host-reported cost carries no
    // spend signal. The usual cause is a streaming response whose provider did
    // not return token usage — e.g. an OpenAI-compatible provider at a
    // non-standard base URL where OpenClaw omits `stream_options:{include_usage:
    // true}` because the provider's `compat.supportsUsageInStreaming` resolved
    // to false. Recording it would add a 0-token / $0 row that looks like a free
    // call but is really a measurement gap, so skip it and count it instead.
    if (
      usageEvent.tokensIn === 0 &&
      usageEvent.tokensOut === 0 &&
      usageEvent.costUsd === undefined
    ) {
      incompleteUsageEvents += 1;
      if (incompleteUsageEvents === 1 || incompleteUsageEvents % 50 === 0) {
        warn?.(
          `tokenomics: ${incompleteUsageEvents} model.usage event(s) for ${usageEvent.provider}/${usageEvent.model} carried no token usage or cost and were not recorded — the provider may not report streaming usage (for OpenAI-compatible providers set the provider's compat.supportsUsageInStreaming=true)`,
        );
      }
      return;
    }
    adapter.track(usageEvent);
  }

  function openLedger(): Ledger {
    return new Ledger(ledgerPath ?? "", {
      onMalformed: (count) =>
        warn?.(`tokenomics: skipped ${count} malformed ledger line(s) while reading`),
      onError: (err) =>
        warn?.(`tokenomics: failed to write ledger entry: ${safeErrorMessage(err)}`),
    });
  }

  function reportFor(window: Window, params: URLSearchParams): Report {
    const granRaw = params.get("gran");
    const gran: Gran = granRaw ? parseGran(granRaw) : "day";
    const period = params.get("period") ?? undefined;
    const pricing = pricingPath
      ? PricingCatalog.load(pricingPath, { logger: warn })
      : new PricingCatalog();
    return buildReport({
      ledger: openLedger(),
      pricing,
      since: window.since,
      until: window.until,
      gran,
      period,
    });
  }

  // FinOps view: read-only allocation / realized-rate / cache-savings / advisor /
  // forecast rollups over the same ledger (consumes ./finops.ts). Non-enforcing.
  function finOpsReportFor(window: Window): FinOpsReport {
    const pricing = pricingPath
      ? PricingCatalog.load(pricingPath, { logger: warn })
      : new PricingCatalog();
    return buildFinOpsReport(openLedger(), pricing, {
      since: window.since,
      until: window.until,
    });
  }

  // Tolerant programmatic entrypoint: bad params fall back to the default window.
  function currentReport(params: URLSearchParams): Report {
    const resolved = resolveWindow(params);
    const window: Window =
      "error" in resolved
        ? { since: new Date(Date.now() - DEFAULT_WINDOW_DAYS * DAY_MS), until: new Date() }
        : resolved;
    return reportFor(window, params);
  }

  const handler: OpenClawPluginHttpRouteHandler = (req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.statusCode = 405;
      res.setHeader("Allow", "GET, HEAD");
      res.end("Method Not Allowed");
      return true;
    }
    if (!ledgerPath) {
      res.statusCode = 503;
      res.end("tokenomics service not started");
      return true;
    }
    const url = new URL(req.url ?? "/", "http://localhost");
    const window = resolveWindow(url.searchParams);
    if ("error" in window) {
      res.statusCode = 400;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end(window.error);
      return true;
    }
    if (url.searchParams.get("view") === "finops") {
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.setHeader("Cache-Control", "no-store");
      if (req.method === "HEAD") {
        res.end();
        return true;
      }
      res.end(JSON.stringify(finOpsReportFor(window)));
      return true;
    }
    const format = url.searchParams.get("format") ?? "json";
    const report = reportFor(window, url.searchParams);
    if (format === "text") {
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.setHeader("Cache-Control", "no-store");
      if (req.method === "HEAD") {
        res.end();
        return true;
      }
      res.end(renderReport(report));
      return true;
    }
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    if (req.method === "HEAD") {
      res.end();
      return true;
    }
    res.end(JSON.stringify(report));
    return true;
  };

  const service = {
    id: "tokenomics",
    start(ctx: OpenClawPluginServiceContext) {
      const dir = join(ctx.stateDir, SUBDIR);
      ledgerPath = join(dir, LEDGER_FILE);
      pricingPath = join(dir, PRICING_FILE);
      warn = (msg) => ctx.logger.warn(msg);
      const pricing = PricingCatalog.load(pricingPath, { logger: warn });
      adapter = new HostAdapter(ledgerPath, "openclaw", { pricing });

      const subscribe = ctx.internalDiagnostics?.onEvent;
      if (!subscribe) {
        ctx.logger.error(
          "tokenomics: internal diagnostics capability unavailable; spend will not be recorded",
        );
        return;
      }
      unsubscribe = subscribe((event, metadata) => {
        if (event.type !== "model.usage" || !shouldRecord(metadata)) {
          return;
        }
        try {
          recordUsage(event);
        } catch (err) {
          ctx.logger.error(`tokenomics: failed to record usage event: ${safeErrorMessage(err)}`);
        }
      });
      ctx.logger.info(`tokenomics: recording model spend to ${ledgerPath}`);
    },
    stop() {
      unsubscribe?.();
      unsubscribe = undefined;
      adapter = undefined;
    },
  } satisfies OpenClawPluginService;

  return { service, handler, report: currentReport };
}

export const testApi = { toUsageEvent, parseBound };
export { testApi as __test__ };
