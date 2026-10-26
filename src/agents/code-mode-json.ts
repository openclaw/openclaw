import { jsonUtf8Bytes } from "../infra/json-utf8-bytes.js";
import { truncateUtf8Prefix } from "../utils/utf8-truncate.js";
import { createJsonPrefixFitter } from "./code-mode-json-fit.js";
import {
  fitCodeModeResultReference,
  type CodeModeResultReference,
} from "./code-mode-result-preview.js";
import { estimateToolResultTextChars } from "./embedded-agent-runner/tool-result-text-budget.js";
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

function jsonBudget(text: string) {
  return {
    chars: estimateToolResultTextChars(text),
    contextChars: estimateToolResultTextChars(text, { minimumRawWeight: 2 }),
  };
}

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
  const originalDigits = String(originalBytes).length;
  const digitBoundary = 10 ** (originalDigits - 1);
  const fixedBytes = jsonUtf8Bytes(marker) - 2 - originalDigits;
  let fixedBudget: ReturnType<typeof jsonBudget> | undefined;
  const fit = createJsonPrefixFitter(source.json, maxBytes, (prefixBytes) => {
    // Prefix probes need only the width, not a decimal string for every byte.
    let digits = originalDigits;
    for (
      let boundary = digitBoundary;
      boundary > 1 && originalBytes - prefixBytes < boundary;
      boundary /= 10
    ) {
      digits--;
    }
    return fixedBytes + digits;
  });
  return (limit: number) => {
    const prefix = fit(limit);
    const omittedBytes = originalBytes - prefix.bytes;
    return {
      marker() {
        return { ...marker, omittedBytes, prefix: prefix.text };
      },
      budget() {
        const fixed = (fixedBudget ??= jsonBudget(JSON.stringify(marker)));
        const digits = String(omittedBytes).length - String(originalBytes).length;
        return {
          chars: fixed.chars - 2 + digits + prefix.budget.chars,
          contextChars: fixed.contextChars - 4 + digits * 2 + prefix.budget.contextChars,
        };
      },
      prefixBytes: prefix.bytes,
      jsonBytes: fixedBytes + String(omittedBytes).length + prefix.jsonBytes,
    };
  };
}

function createErrorFitter(error: string, maxBytes: number) {
  const suffix = " [error truncated]";
  const fit = createJsonPrefixFitter(error, maxBytes, () => suffix.length);
  return (limit: number) => {
    const prefix = fit(limit);
    return {
      text() {
        return `${prefix.text}${suffix}`;
      },
      budget() {
        return {
          chars: prefix.budget.chars + suffix.length,
          contextChars: prefix.budget.contextChars + suffix.length * 2,
        };
      },
      jsonBytes: prefix.jsonBytes + suffix.length,
    };
  };
}

export function boundCodeModeError(error: string, maxBytes: number): string {
  return jsonUtf8Bytes(error) <= maxBytes
    ? error
    : createErrorFitter(error, maxBytes)(maxBytes).text();
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
      const project = this.createProjector(channels, metadata);
      const fitsTrial = (limit: number) => {
        // Network content needs the sanitizer's complete rendered text.
        if (networkContent || !this.modelBudget) {
          return fits(project(limit));
        }
        const measured = project(limit, "budget");
        return (
          measured.chars <= this.modelBudget.maxChars &&
          measured.contextChars <= this.modelBudget.maxContextChars
        );
      };
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
        let best: number | undefined;
        while (low <= high) {
          const middle = Math.floor((low + high) / 2);
          if (fitsTrial(middle)) {
            best = middle;
            low = middle + 1;
          } else {
            high = middle - 1;
          }
        }
        return best === undefined ? undefined : project(best);
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
    const { receipt, channels } = projection;
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

  private createProjector(params: TerminalChannels, metadata: object) {
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
      ? Math.min(outputBytes, createTruncationMarker(source, this.maxBytes)(0).jsonBytes + 2)
      : 0;
    const errorBytes = fullError === undefined ? 0 : jsonUtf8Bytes(fullError);
    // Reuse decoded channels only within this fit; later deliveries need fresh objects.
    let completeOutput: unknown[] | undefined;
    let completeValue: { value: unknown } | undefined;
    let envelopeBudget: ReturnType<typeof jsonBudget> | undefined;
    let completeOutputBudget: ReturnType<typeof jsonBudget> | undefined;
    let completeValueBudget: ReturnType<typeof jsonBudget> | undefined;
    let completeErrorBudget: ReturnType<typeof jsonBudget> | undefined;
    let outputMarker: ReturnType<typeof createTruncationMarker> | undefined;
    let valueMarker: ReturnType<typeof createTruncationMarker> | undefined;
    let errorFitter: ReturnType<typeof createErrorFitter> | undefined;
    const sourceLimit = this.maxBytes;
    type Projection = {
      channels: DeliveredChannels;
      receipt: DeliveryReceipt;
      valueTruncated: boolean;
      referenceUsed: boolean;
    };
    function project(maxBytes: number, mode: "budget"): ReturnType<typeof jsonBudget>;
    function project(maxBytes: number, mode?: "channels"): Projection;
    function project(
      maxBytes: number,
      mode = "channels",
    ): Projection | ReturnType<typeof jsonBudget> {
      // Short channels donate their unused share; diagnostics retain their leading cause.
      const errorAllowance =
        maxBytes - Math.min(outputBytes + valueBytes, Math.floor(maxBytes / 2));
      const fittedError =
        fullError !== undefined && errorBytes > errorAllowance
          ? (errorFitter ??= createErrorFitter(fullError, sourceLimit))(errorAllowance)
          : undefined;
      const remaining = maxBytes - (fittedError?.jsonBytes ?? errorBytes);
      const valueReservation = Math.max(
        Math.floor(remaining / 2),
        remaining >= referenceBytes + minimumOutputBytes ? referenceBytes : 0,
      );
      const outputAllowance = remaining - Math.min(valueBytes, valueReservation);
      let fittedOutput: ReturnType<ReturnType<typeof createTruncationMarker>> | undefined;
      let chargedOutputBytes: number;
      if (outputBytes <= outputAllowance) {
        // A retained prefix has originalBytes > maxBytes and cannot fit this allowance.
        chargedOutputBytes = outputBytes;
      } else {
        const fitted = (fittedOutput = (outputMarker ??= createTruncationMarker(
          source,
          sourceLimit,
        ))(outputAllowance - 2));
        chargedOutputBytes = fitted.jsonBytes + 2;
      }
      const valueAllowance = remaining - chargedOutputBytes;
      const saved = reference ? retainedMarker(reference, valueAllowance) : undefined;
      const valueTruncated =
        value !== undefined &&
        (reference !== undefined || value.kind !== "complete" || valueBytes > valueAllowance);
      const fittedValue =
        value && !saved && valueTruncated
          ? (valueMarker ??= createTruncationMarker(value, sourceLimit, params.valueGuidance))(
              valueAllowance,
            )
          : undefined;
      if (mode === "budget") {
        if (!envelopeBudget) {
          const placeholders = {
            output: null,
            ...(params.value === undefined ? {} : { value: null }),
            ...(params.error === undefined ? {} : { error: null }),
          };
          const measured = jsonBudget(
            serializeToolSearchControlResult({ ...metadata, ...placeholders }, true),
          );
          const nullChars = Object.keys(placeholders).length * 4;
          envelopeBudget = {
            chars: measured.chars - nullChars,
            contextChars: measured.contextChars - nullChars * 2,
          };
        }
        const outputBudget =
          fittedOutput?.budget() ?? (completeOutputBudget ??= jsonBudget(source.json));
        const valueBudget =
          value === undefined
            ? undefined
            : saved
              ? jsonBudget(JSON.stringify(saved))
              : (fittedValue?.budget() ?? (completeValueBudget ??= jsonBudget(value.json)));
        const errorBudget =
          fullError === undefined
            ? undefined
            : (fittedError?.budget() ??
              (completeErrorBudget ??= jsonBudget(JSON.stringify(fullError))));
        return {
          chars:
            envelopeBudget.chars +
            outputBudget.chars +
            (fittedOutput ? 2 : 0) +
            (valueBudget?.chars ?? 0) +
            (errorBudget?.chars ?? 0),
          contextChars:
            envelopeBudget.contextChars +
            outputBudget.contextChars +
            (fittedOutput ? 4 : 0) +
            (valueBudget?.contextChars ?? 0) +
            (errorBudget?.contextChars ?? 0),
        };
      }
      return {
        receipt: fittedOutput
          ? { kind: "summary", originalBytes: outputBytes, prefixBytes: fittedOutput.prefixBytes }
          : { kind: "entries", count },
        valueTruncated,
        referenceUsed: saved !== undefined,
        channels: {
          output: fittedOutput
            ? [fittedOutput.marker()]
            : (completeOutput ??= JSON.parse(source.json) as unknown[]), // SAFETY: Complete sources encode normalized arrays.
          ...(value === undefined
            ? {}
            : saved
              ? { value: saved }
              : fittedValue
                ? { value: fittedValue.marker() }
                : (completeValue ??= { value: JSON.parse(value.json) as unknown })),
          ...(fullError === undefined ? {} : { error: fittedError?.text() ?? fullError }),
        },
      };
    }
    return project;
  }
}
