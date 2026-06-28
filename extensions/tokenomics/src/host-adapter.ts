// Host-neutral ingestion seam.
//
// Tokenomics is not tied to any one capture path. A host normalizes its native
// per-call usage into a {@link UsageEvent} and calls {@link ingest}, which
// writes a single ledger row. The report/render layers then work identically.
//
// Cost precedence: an explicit `costUsd` from the host wins (it's the truth for
// what was billed). Otherwise, if the model is classified free, cost is $0;
// else the pricing catalog estimates it. This keeps free-path usage from ever
// being re-billed while still pricing metered calls the host didn't cost out.

import { Ledger, type LedgerEntry } from "./ledger.js";
import type { PricingCatalog } from "./pricing.js";

/** Host-neutral record of one model call, before it becomes a ledger row. */
export interface UsageEvent {
  /** Provider id (e.g. "anthropic", "openai", "openrouter"). */
  provider: string;
  /** Model id as the host reports it. */
  model: string;
  tokensIn: number;
  tokensOut: number;
  /** Authoritative billed cost when the host knows it; omit to derive. */
  costUsd?: number;
  /** ISO-8601 UTC; defaults to now. */
  tsUtc?: string;
  /** Which host emitted this (for provenance/debugging). */
  host?: HostId;
  /** Host-asserted free classification; overrides the catalog/predicate. */
  free?: boolean;
  /** Set when a free-policy guard flagged this spend. */
  violation?: string;
}

/** Host that emitted an event. Common values: `pi`, `claude-code`, `codex`, `cursor`, `openclaw`. */
export type HostId = string;

export interface IngestOptions {
  pricing?: PricingCatalog;
  /** Classify a model as free ($0). Beats the catalog; loses to `event.free`. */
  isFree?: (model: string, provider: string) => boolean;
  /** Clock injection for tests. */
  now?: () => Date;
}

/** Resolve the cost for an event using the precedence rules above. */
export function resolveCost(event: UsageEvent, opts: IngestOptions = {}): number {
  if (typeof event.costUsd === "number" && Number.isFinite(event.costUsd)) {
    return event.costUsd;
  }
  const free = event.free ?? opts.isFree?.(event.model, event.provider) ?? false;
  if (free) {
    return 0;
  }
  return opts.pricing ? opts.pricing.cost(event.model, event.tokensIn, event.tokensOut) : 0;
}

/** Normalize a {@link UsageEvent} into a persisted {@link LedgerEntry}. */
export function toLedgerEntry(event: UsageEvent, opts: IngestOptions = {}): LedgerEntry {
  const now = opts.now ?? (() => new Date());
  const entry: LedgerEntry = {
    ts_utc: event.tsUtc ?? now().toISOString(),
    provider: event.provider,
    model: event.model,
    tokens_in: event.tokensIn,
    tokens_out: event.tokensOut,
    cost_usd: resolveCost(event, opts),
  };
  if (event.violation) {
    entry.violation = event.violation;
  }
  if (event.host) {
    entry.host = event.host;
  }
  return entry;
}

/** Append one usage event to the ledger. Returns the row written. */
export function ingest(ledger: Ledger, event: UsageEvent, opts: IngestOptions = {}): LedgerEntry {
  const entry = toLedgerEntry(event, opts);
  ledger.record(entry);
  return entry;
}

/**
 * A host adapter binds a ledger + ingestion policy so a host integration only
 * has to translate its native event into a {@link UsageEvent} and call `track`.
 */
export class HostAdapter {
  readonly ledger: Ledger;
  constructor(
    ledgerPath: string,
    private readonly host: HostId,
    private readonly opts: IngestOptions = {},
  ) {
    this.ledger = new Ledger(ledgerPath);
  }

  track(event: Omit<UsageEvent, "host">): LedgerEntry {
    return ingest(this.ledger, { ...event, host: this.host }, this.opts);
  }
}
