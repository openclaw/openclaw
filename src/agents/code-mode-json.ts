import { jsonUtf8Bytes } from "../infra/json-utf8-bytes.js";
import { truncateUtf8Prefix } from "../utils/utf8-truncate.js";
import { createJsonPrefixFitter } from "./code-mode-json-fit.js";
import {
  fitCodeModeResultReference,
  type CodeModeResultReference,
} from "./code-mode-result-preview.js";
import { toolResultFitsBudget, type ToolResultBudget } from "./tool-result-limits.js";
import {
  renderToolSearchControlText,
  serializeToolSearchControlResult,
} from "./tool-search-control-result.js";

export function toCodeModeJsonSafe(value: unknown): unknown {
  if (value === undefined) {
    return null;
  }
  // Strings, booleans and null need no detachment or JSON normalization.
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  return JSON.parse(stringifyCodeModeJsonSafe(value)) as unknown;
}

/** Serialize once before checking a data allowance; detachment can happen after admission. */
export function stringifyCodeModeJsonSafe(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "null";
  } catch {
    if (value instanceof Error) {
      return JSON.stringify({ name: value.name, message: value.message });
    }
    switch (typeof value) {
      case "number":
        return JSON.stringify(value);
      case "bigint":
      case "symbol":
      case "function":
        return JSON.stringify(String(value));
      default:
        return JSON.stringify(Object.prototype.toString.call(value));
    }
  }
}

export type CodeModeJsonSource =
  | { kind: "complete"; json: string }
  | { kind: "prefix"; json: string; originalBytes: number };

export type CodeModeOutputSource = { count: number; source: CodeModeJsonSource };

export const EMPTY_CODE_MODE_OUTPUT: CodeModeOutputSource = {
  count: 0,
  source: { kind: "complete", json: "[]" },
};

function sourceBytes(source: CodeModeJsonSource): number {
  return source.kind === "prefix" ? source.originalBytes : Buffer.byteLength(source.json, "utf8");
}

function retainSource(json: string, originalBytes: number, maxBytes: number): CodeModeJsonSource {
  return originalBytes <= maxBytes
    ? { kind: "complete", json }
    : { kind: "prefix", json: truncateUtf8Prefix(json, maxBytes), originalBytes };
}

/** Capture after guest conversion, before any public projection discards source facts. */
export function captureCodeModeValue(
  value: unknown,
  maxBytes: number,
  structuredMaxBytes = maxBytes,
): CodeModeJsonSource {
  const json = stringifyCodeModeJsonSafe(value);
  const allowance =
    json.startsWith("{") || json.startsWith("[")
      ? Math.max(maxBytes, structuredMaxBytes)
      : maxBytes;
  return retainSource(json, Buffer.byteLength(json, "utf8"), allowance);
}

export function captureCodeModeOutput(output: unknown[], maxBytes: number): CodeModeOutputSource {
  if (output.length === 0) {
    return EMPTY_CODE_MODE_OUTPUT;
  }
  const json = JSON.stringify(output.map(toCodeModeJsonSafe));
  return {
    count: output.length,
    source: retainSource(json, Buffer.byteLength(json, "utf8"), maxBytes),
  };
}

const TRUNCATION_GUIDANCE = "Output truncated; rerun with narrower args.";
const RETAINED_GUIDANCE =
  "Full result saved for this run; use results.load(reference.id) in a later exec.";

function retainedMarker(reference: CodeModeResultReference, maxBytes: number) {
  const overhead =
    jsonUtf8Bytes({ truncated: true, reference: null, guidance: RETAINED_GUIDANCE }) - 4;
  const fitted = fitCodeModeResultReference(reference, maxBytes - overhead);
  return fitted ? { truncated: true, reference: fitted, guidance: RETAINED_GUIDANCE } : undefined;
}

function createTruncationMarker(
  source: CodeModeJsonSource,
  maxBytes: number,
  guidance = TRUNCATION_GUIDANCE,
) {
  const originalBytes = sourceBytes(source);
  const marker = {
    truncated: true,
    omittedBytes: originalBytes,
    guidance,
    prefix: "",
  };
  const fixedBytes = jsonUtf8Bytes(marker) - 2 - String(originalBytes).length;
  const fit = createJsonPrefixFitter(
    source.json,
    maxBytes,
    (prefixBytes) => fixedBytes + String(originalBytes - prefixBytes).length,
  );
  return (limit: number) => {
    const prefix = fit(limit);
    return { ...marker, omittedBytes: originalBytes - Buffer.byteLength(prefix, "utf8"), prefix };
  };
}

function createErrorFitter(error: string, maxBytes: number) {
  const suffix = " [error truncated]";
  const fit = createJsonPrefixFitter(error, maxBytes, () => suffix.length);
  return (limit: number) => `${fit(limit)}${suffix}`;
}

export function boundCodeModeError(error: string, maxBytes: number): string {
  return jsonUtf8Bytes(error) <= maxBytes ? error : createErrorFitter(error, maxBytes)(maxBytes);
}

type DeliveryReceipt =
  | { kind: "entries"; count: number }
  | { kind: "summary"; originalBytes: number; prefixBytes: number };
export type CodeModeValueRetention =
  | { reference: CodeModeResultReference; release: () => void }
  | { reason: string };
type TerminalChannels = {
  value?: CodeModeJsonSource;
  error?: string;
  valueGuidance?: string;
  reference?: CodeModeResultReference;
};
type DeliveredChannels = { output: unknown[]; value?: unknown; error?: string };

/** One bounded cumulative source and delivery receipt, shared across every worker leg. */
export class CodeModeOutputState {
  source: CodeModeOutputSource = EMPTY_CODE_MODE_OUTPUT;
  private delivered: DeliveryReceipt = { kind: "entries", count: 0 };

  constructor(
    private readonly maxBytes: number,
    private readonly modelBudget?: ToolResultBudget,
  ) {}

  append(leg: CodeModeOutputSource): void {
    if (leg.count === 0) {
      return;
    }
    if (this.source.count === 0) {
      this.source = leg;
      return;
    }
    const previous = this.source.source;
    const originalBytes = sourceBytes(previous) + sourceBytes(leg.source) - 1;
    // Nonempty array concatenation removes two brackets and adds one comma.
    // A missing earlier suffix forbids appending any later prefix after that hole.
    const json =
      previous.kind === "prefix"
        ? previous.json
        : previous.json.slice(0, -1) + "," + leg.source.json.slice(1);
    this.source = {
      count: this.source.count + leg.count,
      source: retainSource(json, originalBytes, this.maxBytes),
    };
  }

  take(params: TerminalChannels & { error: string }): DeliveredChannels & { error: string };
  take(params?: TerminalChannels): DeliveredChannels;
  take(params: TerminalChannels = {}): DeliveredChannels {
    return this.takeResult({}, params);
  }

  takeResult<T extends object>(
    metadata: T,
    params: TerminalChannels & { error: string },
    networkContent?: boolean,
    retainValue?: (source: CodeModeJsonSource) => CodeModeValueRetention,
  ): T & DeliveredChannels & { error: string };
  takeResult<T extends object>(
    metadata: T,
    params?: TerminalChannels,
    networkContent?: boolean,
    retainValue?: (source: CodeModeJsonSource) => CodeModeValueRetention,
  ): T & DeliveredChannels;
  takeResult<T extends object>(
    metadata: T,
    params: TerminalChannels = {},
    networkContent = false,
    retainValue?: (source: CodeModeJsonSource) => CodeModeValueRetention,
  ): T & DeliveredChannels {
    const fit = (channels: TerminalChannels) => {
      const project = this.createProjector(channels);
      const fits = (candidate: ReturnType<typeof project>) => {
        const rendered = renderToolSearchControlText(
          serializeToolSearchControlResult({ ...metadata, ...candidate.channels }, true),
          networkContent,
        );
        return !rendered.truncated && toolResultFitsBudget(rendered.text, this.modelBudget);
      };
      const projection = project(this.maxBytes);
      if ((this.modelBudget || networkContent) && !fits(projection)) {
        let low = 0;
        let high = this.maxBytes - 1;
        let best: typeof projection | undefined;
        while (low <= high) {
          const middle = Math.floor((low + high) / 2);
          const candidate = project(middle);
          if (fits(candidate)) {
            best = candidate;
            low = middle + 1;
          } else {
            high = middle - 1;
          }
        }
        return best;
      }
      return projection;
    };
    const original = fit(params);
    if (!original) {
      throw new Error(
        "Model tool-result budget cannot fit Code Mode status; use a larger model context.",
      );
    }
    let projection = original;
    // Retention metadata may shrink, but cannot invalidate already fitted success.
    const fitNonRetention = (guidance: string) =>
      fit({ ...params, valueGuidance: guidance }) ??
      fit({ ...params, valueGuidance: "Not retained; return less data." }) ??
      original;
    if (
      retainValue &&
      params.value &&
      projection.valueTruncated &&
      (params.value.json.startsWith("{") || params.value.json.startsWith("["))
    ) {
      const saved = retainValue(params.value);
      if ("reference" in saved) {
        let delivered = false;
        try {
          const retained = fit({ ...params, reference: saved.reference });
          if (retained?.referenceUsed) {
            projection = retained;
            delivered = true;
          } else {
            projection = fitNonRetention(
              "Not retained: reference exceeds output budget. Return less data.",
            );
          }
        } finally {
          if (!delivered) {
            saved.release();
          }
        }
      } else {
        projection = fitNonRetention(saved.reason);
      }
    }
    const prior = this.delivered;
    const { channels, receipt } = projection;
    // Trial projections never acknowledge delivery. Charge the cumulative output
    // before suppressing earlier entries or an unchanged replacement summary.
    this.delivered = receipt;
    const output =
      receipt.kind === "entries"
        ? channels.output.slice(prior.kind === "entries" ? prior.count : 0)
        : prior.kind === "summary" &&
            prior.originalBytes === receipt.originalBytes &&
            prior.prefixBytes === receipt.prefixBytes
          ? []
          : channels.output;
    return { ...metadata, ...channels, output };
  }

  private createProjector(params: TerminalChannels) {
    const { count, source } = this.source;
    const { value, error: fullError, reference } = params;
    const outputBytes = count === 0 ? 0 : sourceBytes(source);
    const valueBytes = reference
      ? jsonUtf8Bytes({ truncated: true, reference, guidance: RETAINED_GUIDANCE })
      : value === undefined
        ? 0
        : sourceBytes(value);
    const minimumReference = reference
      ? retainedMarker({ ...reference, shape: "", preview: "", previewTruncated: true }, Infinity)
      : undefined;
    const referenceBytes = minimumReference ? jsonUtf8Bytes(minimumReference) : 0;
    const minimumOutputBytes = reference
      ? Math.min(outputBytes, jsonUtf8Bytes([createTruncationMarker(source, this.maxBytes)(0)]))
      : 0;
    const errorBytes = fullError === undefined ? 0 : jsonUtf8Bytes(fullError);
    // Reuse decoded channels only within this fit; later deliveries need fresh objects.
    let completeOutput: unknown[] | undefined;
    let completeValue: { value: unknown } | undefined;
    let outputMarker: ReturnType<typeof createTruncationMarker> | undefined;
    let valueMarker: ReturnType<typeof createTruncationMarker> | undefined;
    let errorFitter: ReturnType<typeof createErrorFitter> | undefined;
    return (
      maxBytes: number,
    ): {
      channels: DeliveredChannels;
      receipt: DeliveryReceipt;
      valueTruncated: boolean;
      referenceUsed: boolean;
    } => {
      // Short channels donate their unused share; diagnostics retain their leading cause.
      const errorAllowance =
        maxBytes - Math.min(outputBytes + valueBytes, Math.floor(maxBytes / 2));
      const error =
        fullError === undefined || errorBytes <= errorAllowance
          ? fullError
          : (errorFitter ??= createErrorFitter(fullError, this.maxBytes))(errorAllowance);
      const remaining = maxBytes - (error === fullError ? errorBytes : jsonUtf8Bytes(error));
      const valueReservation = Math.max(
        Math.floor(remaining / 2),
        remaining >= referenceBytes + minimumOutputBytes ? referenceBytes : 0,
      );
      const outputAllowance = remaining - Math.min(valueBytes, valueReservation);
      let output: unknown[];
      let chargedOutputBytes: number;
      let receipt: DeliveryReceipt;
      if (outputBytes <= outputAllowance) {
        // A retained prefix has originalBytes > maxBytes and cannot fit this allowance.
        // SAFETY: Complete output sources encode normalized arrays, never guest metadata.
        output = completeOutput ??= JSON.parse(source.json) as unknown[];
        chargedOutputBytes = outputBytes;
        receipt = { kind: "entries", count };
      } else {
        const marker = (outputMarker ??= createTruncationMarker(source, this.maxBytes))(
          outputAllowance - 2,
        );
        const prefixBytes = Buffer.byteLength(marker.prefix, "utf8");
        output = [marker];
        chargedOutputBytes = jsonUtf8Bytes([marker]);
        receipt = { kind: "summary", originalBytes: outputBytes, prefixBytes };
      }
      const valueAllowance = remaining - chargedOutputBytes;
      const saved = reference ? retainedMarker(reference, valueAllowance) : undefined;
      const valueTruncated =
        value !== undefined &&
        (reference !== undefined || value.kind !== "complete" || valueBytes > valueAllowance);
      return {
        receipt,
        valueTruncated,
        referenceUsed: saved !== undefined,
        channels: {
          output,
          ...(value === undefined
            ? {}
            : saved
              ? { value: saved }
              : !reference &&
                  value.kind === "complete" &&
                  valueBytes <= remaining - chargedOutputBytes
                ? (completeValue ??= { value: JSON.parse(value.json) as unknown })
                : {
                    value: (valueMarker ??= createTruncationMarker(
                      value,
                      this.maxBytes,
                      params.valueGuidance,
                    ))(remaining - chargedOutputBytes),
                  }),
          ...(error === undefined ? {} : { error }),
        },
      };
    };
  }
}
