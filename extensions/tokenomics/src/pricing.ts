// Model pricing catalog. Rates are realized `$ / 1M tokens` in the public
// price-list shape (LiteLLM `input/output_cost_per_token`, OpenRouter
// `pricing.prompt/completion`, scaled to per-Mtok). The catalog drives the
// cost-counterfactual / avoided-spend headline in a report; per-call cost in
// the ledger is the truth for what was actually paid.

import {
  closeSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

export interface ModelPrice {
  /** Legacy blended rate (input+output) in USD per 1M tokens. Fallback only. */
  usd_per_mtok?: number;
  /** Per-component rates in USD per 1M tokens (take precedence when set). */
  input_usd_per_mtok?: number;
  output_usd_per_mtok?: number;
  cache_read_usd_per_mtok?: number;
  cache_write_usd_per_mtok?: number;
  reasoning_usd_per_mtok?: number;
  source?: string;
}

export interface PricingCatalogJson {
  generated?: string;
  window?: string;
  models?: Record<string, ModelPrice>;
  /** Frontier baseline `$ / 1M tok` for the avoided-spend estimate. */
  baseline_usd_per_mtok?: number;
  baseline_model?: string;
}

function priceIsPriced(p: ModelPrice): boolean {
  return (
    (p.usd_per_mtok ?? 0) > 0 || (p.input_usd_per_mtok ?? 0) > 0 || (p.output_usd_per_mtok ?? 0) > 0
  );
}

/** Validate a model price entry. Returns a list of field-level warnings. */
export function validateModelPrice(
  modelId: string,
  raw: unknown,
): { valid: boolean; warnings: string[] } {
  const warnings: string[] = [];
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { valid: false, warnings: [`model "${modelId}": value is not an object, skipping`] };
  }
  const p = raw as Record<string, unknown>;
  const numericFields = [
    "usd_per_mtok",
    "input_usd_per_mtok",
    "output_usd_per_mtok",
    "cache_read_usd_per_mtok",
    "cache_write_usd_per_mtok",
    "reasoning_usd_per_mtok",
  ] as const;
  for (const f of numericFields) {
    const v = p[f];
    if (v === undefined) {
      continue;
    }
    // A finite, non-negative number is a real rate — keep it.
    if (typeof v === "number" && Number.isFinite(v) && v >= 0) {
      continue;
    }
    // A finite negative value is the catalog's "unpriced / unknown" sentinel
    // (e.g. -1000000). Drop the field silently — it is intentional, not
    // malformed, so it must not spam a warning on every report.
    if (typeof v === "number" && Number.isFinite(v)) {
      delete p[f];
      continue;
    }
    // Genuinely malformed (non-number, NaN, Infinity): warn and drop.
    warnings.push(
      `model "${modelId}": ${f}=${JSON.stringify(v)} is not a finite number, skipping field`,
    );
    delete p[f];
  }
  if (p.source !== undefined && typeof p.source !== "string") {
    warnings.push(`model "${modelId}": source is not a string, skipping field`);
    delete p.source;
  }
  // Check that at least one rate field remains after cleaning.
  const hasRate = numericFields.some((f) => typeof p[f] === "number");
  if (!hasRate) {
    warnings.push(`model "${modelId}": no valid rate fields remain, skipping model`);
    return { valid: false, warnings };
  }
  return { valid: true, warnings };
}

/** Cost in USD for an input/output token split (component rates, else blended). */
export function priceCostIo(p: ModelPrice, tokensIn: number, tokensOut: number): number {
  const inRate = p.input_usd_per_mtok ?? 0;
  const outRate = p.output_usd_per_mtok ?? 0;
  if (inRate > 0 || outRate > 0) {
    return (tokensIn * inRate + tokensOut * outRate) / 1_000_000;
  }
  return ((p.usd_per_mtok ?? 0) * (tokensIn + tokensOut)) / 1_000_000;
}

/**
 * True when the current platform uses POSIX file permission semantics
 * (mode bits and uid/gid are meaningful). Returns false on Windows (`win32`).
 */
export function isPosixPlatform(): boolean {
  return process.platform !== "win32";
}

/**
 * Validate that a file is safe to use as a pricing catalog input.
 *
 * Checks performed:
 * - File must exist and be a regular file (all platforms).
 * - **POSIX only:** File mode must not include S_IWGRP (0o020) or S_IWOTH
 *   (0o002). On Windows `stat.mode` does not reflect POSIX permissions and
 *   typically includes write bits for everyone; mode checks are skipped there.
 * - **POSIX only:** File uid must match the process uid. Skipped when
 *   `process.getuid` is unavailable (Windows).
 *
 * Pass `{ posix: false }` to simulate Windows semantics (mode/uid checks
 * skipped); defaults to {@link isPosixPlatform}.
 *
 * Returns `{ ok: false, reason }` when the file fails any check.
 */
export function validatePricingFile(
  path: string,
  opts?: { posix?: boolean },
): { ok: true } | { ok: false; reason: string } {
  const posix = opts?.posix ?? isPosixPlatform();
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(path);
  } catch (err) {
    return { ok: false, reason: `cannot stat: ${String(err)}` };
  }
  if (!stat.isFile()) {
    return { ok: false, reason: "not a regular file" };
  }
  // Mode-bit checks are only meaningful on POSIX.
  if (posix) {
    const badMode = 0o020 /* S_IWGRP */ | 0o002; /* S_IWOTH */
    if (stat.mode & badMode) {
      const modeStr = (stat.mode & 0o777).toString(8).padStart(3, "0");
      return {
        ok: false,
        reason: `insecure mode 0o${modeStr} (must not be group- or world-writable)`,
      };
    }
    // Verify ownership matches the process.
    try {
      if (typeof process.getuid === "function") {
        const procUid = process.getuid();
        if (procUid !== undefined && stat.uid !== procUid) {
          return {
            ok: false,
            reason: `owned by uid ${stat.uid}, process is uid ${procUid}`,
          };
        }
      }
    } catch {
      // process.getuid may throw on some platforms; skip.
    }
  }
  return { ok: true };
}

/**
 * Commodity: return the process uid when available, or undefined on platforms
 * that do not expose it (Windows).
 */
export function getProcessUid(): number | undefined {
  try {
    if (typeof process.getuid === "function") {
      return process.getuid();
    }
  } catch {
    // ignore
  }
  return undefined;
}

export class PricingCatalog {
  generated = "";
  window = "";
  models: Map<string, ModelPrice> = new Map();
  baselineUsdPerMtok = 0;
  baselineModel = "";

  /**
   * Load, or an empty catalog if absent/corrupt/insecure/oversized (never
   * fatal).
   *
   * File size is checked *before* opening a descriptor: oversized files are
   * rejected with a warning and no fd is ever created, preventing descriptor
   * leaks under repeated oversized-file loads.
   *
   * For files that pass the size gate, the method opens a file descriptor,
   * validates permissions via `fstatSync` on that descriptor, and reads from
   * the same descriptor — eliminating the TOCTOU race between check and read.
   *
   * Pass `{ posix: false }` to skip POSIX mode/uid checks (Windows).
   * Pass `{ logger }` to route warnings through the host's logging
   * infrastructure instead of raw `process.stderr` writes.
   */
  static load(
    path: string,
    opts?: { posix?: boolean; logger?: (msg: string) => void },
  ): PricingCatalog {
    const cat = new PricingCatalog();
    const posix = opts?.posix ?? isPosixPlatform();
    const warn =
      opts?.logger ??
      ((msg: string) => {
        process.stderr.write(msg);
      });

    // ── size gate (before any descriptor is opened) ──
    const MAX_PRICE_BYTES = 2_097_152; // 2 MiB
    try {
      const sizeStat = statSync(path);
      if (!sizeStat.isFile()) {
        warn(
          `tokenomics: warning: pricing catalog ${path} rejected — not a regular file; using empty\n`,
        );
        return cat;
      }
      if (sizeStat.size > MAX_PRICE_BYTES) {
        warn(
          `tokenomics: warning: pricing catalog ${path} rejected — ${sizeStat.size} bytes exceeds ${MAX_PRICE_BYTES} limit; using empty\n`,
        );
        return cat;
      }
    } catch (err) {
      warn(
        `tokenomics: warning: pricing catalog ${path} rejected — cannot stat: ${String(err)}; using empty\n`,
      );
      return cat;
    }

    // ── descriptor-backed permission check + read ──
    let fd: number | undefined;
    try {
      fd = openSync(path, "r");
      const stat = fstatSync(fd);
      if (posix) {
        const badMode = 0o020 /* S_IWGRP */ | 0o002; /* S_IWOTH */
        if (stat.mode & badMode) {
          const modeStr = (stat.mode & 0o777).toString(8).padStart(3, "0");
          warn(
            `tokenomics: warning: pricing catalog ${path} rejected — insecure mode 0o${modeStr} (must not be group- or world-writable); using empty\n`,
          );
          return cat;
        }
        try {
          if (typeof process.getuid === "function") {
            const procUid = process.getuid();
            if (procUid !== undefined && stat.uid !== procUid) {
              warn(
                `tokenomics: warning: pricing catalog ${path} rejected — owned by uid ${stat.uid}, process is uid ${procUid}; using empty\n`,
              );
              return cat;
            }
          }
        } catch {
          // process.getuid may throw on some platforms; skip.
        }
      }
      let raw: string;
      try {
        raw = readFileSync(fd, { encoding: "utf8" });
      } catch {
        return cat;
      }
      try {
        const j = JSON.parse(raw) as PricingCatalogJson;
        cat.generated = typeof j.generated === "string" ? j.generated : "";
        cat.window = typeof j.window === "string" ? j.window : "";
        cat.baselineUsdPerMtok =
          typeof j.baseline_usd_per_mtok === "number" && Number.isFinite(j.baseline_usd_per_mtok)
            ? j.baseline_usd_per_mtok
            : 0;
        cat.baselineModel = typeof j.baseline_model === "string" ? j.baseline_model : "";
        const models = j.models;
        if (models && typeof models === "object" && !Array.isArray(models)) {
          let skipped = 0;
          for (const [k, v] of Object.entries(models)) {
            const { valid, warnings } = validateModelPrice(k, v);
            if (valid) {
              cat.models.set(k, v);
            } else {
              skipped += 1;
            }
            for (const w of warnings) {
              warn(`tokenomics: warning: ${w}\n`);
            }
          }
          if (skipped > 0) {
            warn(
              `tokenomics: warning: skipped ${skipped} malformed model entr${skipped === 1 ? "y" : "ies"} in ${path}\n`,
            );
          }
        }
      } catch (e) {
        warn(
          `tokenomics: warning: pricing catalog ${path} unreadable (${String(e)}); using empty\n`,
        );
      }
    } finally {
      if (fd !== undefined) {
        closeSync(fd);
      }
    }
    return cat;
  }

  toJSON(): PricingCatalogJson {
    return {
      generated: this.generated,
      window: this.window,
      models: Object.fromEntries(this.models),
      baseline_usd_per_mtok: this.baselineUsdPerMtok,
      baseline_model: this.baselineModel,
    };
  }

  /** Atomic write (temp + rename). */
  save(path: string): void {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(this.toJSON(), null, 2)}\n`);
    renameSync(tmp, path);
  }

  /**
   * Look up a model price, tolerating id vs display-name drift: exact, then
   * case-insensitive, then leaf/suffix match (`host/leaf` -> `leaf`).
   */
  lookup(model: string): ModelPrice | undefined {
    const exact = this.models.get(model);
    if (exact) {
      return exact;
    }
    const ml = model.toLowerCase();
    const leaf = ml.includes("/") ? ml.slice(ml.lastIndexOf("/") + 1) : ml;
    for (const [k, v] of this.models) {
      const kl = k.toLowerCase();
      if (kl === ml || kl === leaf || ml.endsWith(kl) || kl.endsWith(leaf)) {
        return v;
      }
    }
    return undefined;
  }

  /** Chargeback for a call. Unknown/unpriced model → $0 (never invent cost). */
  cost(model: string, tokensIn: number, tokensOut: number): number {
    const p = this.lookup(model);
    return p ? priceCostIo(p, tokensIn, tokensOut) : 0;
  }

  /** True when the model has a non-zero rate (a paid cloud model). */
  isBilled(model: string): boolean {
    const p = this.lookup(model);
    return p ? priceIsPriced(p) : false;
  }

  /** Avoided spend: `tokens` priced at the frontier baseline. */
  avoided(tokens: number): number {
    return (this.baselineUsdPerMtok * tokens) / 1_000_000;
  }
}
