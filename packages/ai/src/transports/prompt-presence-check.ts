/**
 * Prompt presence forensics: bounded containment check of frozen injection
 * expectations against the pre-submission request object.
 *
 * Records forensic facts only. It never mutates the request, never persists
 * body text, and never upgrades a result beyond what was actually checked.
 */
import { isRecord } from "@openclaw/normalization-core";

/** Frozen at assembly time by the injecting plugin; body text is memory-only. */
export type PromptPresenceExpectation = {
  activationId: string;
  revision: number | string;
  /** Exact text the plugin actually returned for this activation (post size guard). */
  bodyText: string;
  bodyChars: number;
  /**
   * False when the assembly size guard truncated this activation: the frozen
   * text is a fragment and must never yield a full_hit.
   */
  bodyComplete: boolean;
};

export type PromptPresenceOutcome = "full_hit" | "checked_missing" | "unknown";

export type PromptPresenceResult = {
  activationId: string;
  revision: number | string;
  outcome: PromptPresenceOutcome;
  /** Required whenever outcome is "unknown". */
  reason?:
    | "assembly_truncated"
    | "body_over_limit"
    | "expectations_over_limit"
    | "scan_region_over_limit"
    | "cumulative_scan_over_limit"
    | "unparseable_content"
    | "check_failed"
    | "missing_expectations";
  /** Set on full_hit: index of the legal-role message that contained the body. */
  hitMessageIndex?: number;
  hitRole?: string;
  /** Body text was found, but only in a non-legal role (user/tool/assistant/...). */
  presentInWrongRole?: boolean;
  actualBodyChars?: number;
};

export type PromptPresenceCheck = {
  checked: boolean;
  /** Required whenever checked is false. */
  reason?: "disabled" | "missing_expectations";
  attemptIndex: number;
  /** Marks what was observed: the pre-submission request object, not the network request. */
  boundary: "pre_submission_request_object";
  results: PromptPresenceResult[];
  limitsExceeded?: {
    expectations?: number;
    bodyChars?: number;
    scanBytes?: number;
    messages?: number;
  };
  checkFailedReason?: string;
};

/** Internal scan limits (configurable constants; historical maxima are not caps). */
export type PromptPresenceLimits = {
  maxExpectations: number;
  maxBodyChars: number;
  maxRegionChars: number;
  maxMessages: number;
  maxCumulativeScanBytes: number;
};

export const DEFAULT_PROMPT_PRESENCE_LIMITS: PromptPresenceLimits = {
  maxExpectations: 64,
  maxBodyChars: 64 * 1024,
  maxRegionChars: 8 * 1024 * 1024,
  maxMessages: 512,
  maxCumulativeScanBytes: 32 * 1024 * 1024,
};

const PRESENCE_EXPECTATIONS = Symbol("openclaw.promptPresenceExpectations");

/** Options-keyed carrier for the frozen expectation set of this request. */
export const promptPresenceExpectations = {
  set(options: object, expectations: readonly PromptPresenceExpectation[]): void {
    Reflect.set(options, PRESENCE_EXPECTATIONS, expectations);
  },
  get(options: object | undefined): readonly PromptPresenceExpectation[] | undefined {
    if (!options) {
      return undefined;
    }
    // SAFETY: Only set() can install this private symbol, with the typed shape above.
    return Reflect.get(options, PRESENCE_EXPECTATIONS) as
      | readonly PromptPresenceExpectation[]
      | undefined;
  },
};

export type ScannedRegion = {
  /** Stable index of the message inside the request's ordered message list. */
  messageIndex: number;
  role: string;
  text: string;
};

type CollectedText = {
  legal: ScannedRegion[];
  other: ScannedRegion[];
  unparseable: boolean;
};

function flattenTextParts(content: unknown): string | undefined {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return undefined;
  }
  let text = "";
  let sawPart = false;
  for (const part of content) {
    if (isRecord(part) && part.type === "input_text" && typeof part.text === "string") {
      text += part.text;
      sawPart = true;
    } else if (typeof part === "string") {
      text += part;
      sawPart = true;
    }
    // Non-text parts (images, files, tool calls) contribute nothing scannable.
  }
  return sawPart ? text : undefined;
}

/** Collects candidate regions from an OpenAI Responses request object. */
export function collectResponsesRegions(request: unknown): CollectedText {
  const legal: ScannedRegion[] = [];
  const other: ScannedRegion[] = [];
  let unparseable = false;
  if (!isRecord(request)) {
    return { legal, other, unparseable: true };
  }
  if (typeof request.instructions === "string") {
    legal.push({ messageIndex: -1, role: "instructions", text: request.instructions });
  }
  const input = Array.isArray(request.input) ? request.input : [];
  input.forEach((item, index) => {
    if (!isRecord(item) || typeof item.role !== "string") {
      return;
    }
    const text = flattenTextParts(item.content);
    if (text === undefined) {
      if (item.content !== undefined && !Array.isArray(item.content)) {
        unparseable = true;
      }
      return;
    }
    if (item.role === "system" || item.role === "developer") {
      legal.push({ messageIndex: index, role: item.role, text });
    } else {
      other.push({ messageIndex: index, role: item.role, text });
    }
  });
  return { legal, other, unparseable };
}

/** Collects candidate regions from an OpenAI Chat Completions request object. */
export function collectCompletionsRegions(params: unknown): CollectedText {
  const legal: ScannedRegion[] = [];
  const other: ScannedRegion[] = [];
  let unparseable = false;
  if (!isRecord(params) || !Array.isArray(params.messages)) {
    return { legal, other, unparseable: true };
  }
  (params.messages as unknown[]).forEach((item, index) => {
    if (!isRecord(item) || typeof item.role !== "string") {
      return;
    }
    const text = flattenTextParts(item.content);
    if (text === undefined) {
      if (item.content !== undefined && !Array.isArray(item.content)) {
        unparseable = true;
      }
      return;
    }
    if (item.role === "system" || item.role === "developer") {
      legal.push({ messageIndex: index, role: item.role, text });
    } else {
      other.push({ messageIndex: index, role: item.role, text });
    }
  });
  return { legal, other, unparseable };
}

function byteLength(text: string): number {
  // UTF-8 byte length; event-size and scan caps are byte-based, not char-based.
  return Buffer.byteLength(text, "utf8");
}

function truncateToUtf8Limit(text: string, limitBytes: number): string {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= limitBytes) {
    return text;
  }
  // Slice code points, never mid-character; result may still be shorter than the limit.
  return bytes.subarray(0, limitBytes).toString("utf8");
}

/**
 * Core bounded containment check. Regions must already be split into legal
 * (system/developer) and other roles. Never throws; failures surface as
 * unknown/check_failed results.
 */
export function runPromptPresenceCheck(input: {
  collected: CollectedText;
  expectations: readonly PromptPresenceExpectation[] | undefined;
  attemptIndex: number;
  limits?: PromptPresenceLimits;
}): PromptPresenceCheck {
  const limits = input.limits ?? DEFAULT_PROMPT_PRESENCE_LIMITS;
  const base: PromptPresenceCheck = {
    checked: false,
    attemptIndex: input.attemptIndex,
    boundary: "pre_submission_request_object",
    results: [],
  };
  if (!input.expectations || input.expectations.length === 0) {
    return {
      ...base,
      reason: input.expectations ? "missing_expectations" : "missing_expectations",
      results: [],
    };
  }
  try {
    if (input.collected.unparseable) {
      return {
        ...base,
        checked: true,
        results: input.expectations.map((expectation) => ({
          activationId: expectation.activationId,
          revision: expectation.revision,
          outcome: "unknown" as const,
          reason: "unparseable_content" as const,
        })),
      };
    }
    if (input.expectations.length > limits.maxExpectations) {
      return {
        ...base,
        checked: true,
        results: input.expectations.map((expectation) => ({
          activationId: expectation.activationId,
          revision: expectation.revision,
          outcome: "unknown" as const,
          reason: "expectations_over_limit" as const,
          actualBodyChars: expectation.bodyChars,
        })),
        limitsExceeded: { expectations: input.expectations.length },
      };
    }
    // Cumulative scan budget covers legal AND wrong-role regions (owner condition 1).
    let cumulativeBytes = 0;
    let cumulativeOverLimit = false;
    for (const region of [...input.collected.legal, ...input.collected.other]) {
      cumulativeBytes += byteLength(region.text);
      if (cumulativeBytes > limits.maxCumulativeScanBytes) {
        cumulativeOverLimit = true;
        break;
      }
    }
    if (cumulativeOverLimit) {
      return {
        ...base,
        checked: true,
        results: input.expectations.map((expectation) => ({
          activationId: expectation.activationId,
          revision: expectation.revision,
          outcome: "unknown" as const,
          reason: "cumulative_scan_over_limit" as const,
          actualBodyChars: expectation.bodyChars,
        })),
        limitsExceeded: { scanBytes: cumulativeBytes },
      };
    }
    const messagesOverLimit =
      input.collected.legal.length > limits.maxMessages ||
      input.collected.other.length > limits.maxMessages;
    const results: PromptPresenceResult[] = input.expectations.map((expectation) => {
      // Owner condition 2: a truncated assembly fragment must never produce full_hit.
      if (!expectation.bodyComplete) {
        return {
          activationId: expectation.activationId,
          revision: expectation.revision,
          outcome: "unknown" as const,
          reason: "assembly_truncated" as const,
          actualBodyChars: expectation.bodyChars,
        };
      }
      if (expectation.bodyText.length > limits.maxBodyChars) {
        return {
          activationId: expectation.activationId,
          revision: expectation.revision,
          outcome: "unknown" as const,
          reason: "body_over_limit" as const,
          actualBodyChars: expectation.bodyChars,
        };
      }
      let hitMessageIndex: number | undefined;
      let hitRole: string | undefined;
      for (const region of input.collected.legal) {
        if (byteLength(region.text) > limits.maxRegionChars) {
          continue;
        }
        if (region.text.includes(expectation.bodyText)) {
          hitMessageIndex = region.messageIndex;
          hitRole = region.role;
          break;
        }
      }
      const presentInWrongRole =
        hitMessageIndex === undefined &&
        input.collected.other.some((region) => region.text.includes(expectation.bodyText));
      if (hitMessageIndex !== undefined) {
        return {
          activationId: expectation.activationId,
          revision: expectation.revision,
          outcome: "full_hit" as const,
          hitMessageIndex,
          hitRole,
          presentInWrongRole: false,
          actualBodyChars: expectation.bodyChars,
        };
      }
      // Unchecked skipped regions (per-message cap) make the missing verdict
      // incomplete: the body might have lived in a region we could not scan.
      const legalSkipped = input.collected.legal.some(
        (region) => byteLength(region.text) > limits.maxRegionChars,
      );
      if (legalSkipped || messagesOverLimit) {
        return {
          activationId: expectation.activationId,
          revision: expectation.revision,
          outcome: "unknown" as const,
          reason: "scan_region_over_limit" as const,
          presentInWrongRole,
          actualBodyChars: expectation.bodyChars,
        };
      }
      return {
        activationId: expectation.activationId,
        revision: expectation.revision,
        outcome: "checked_missing" as const,
        presentInWrongRole,
        actualBodyChars: expectation.bodyChars,
      };
    });
    return {
      ...base,
      checked: true,
      results,
      ...(messagesOverLimit ? { limitsExceeded: { messages: input.collected.legal.length } } : {}),
    };
  } catch (error) {
    return {
      ...base,
      checked: true,
      results: input.expectations.map((expectation) => ({
        activationId: expectation.activationId,
        revision: expectation.revision,
        outcome: "unknown" as const,
        reason: "check_failed" as const,
        actualBodyChars: expectation.bodyChars,
      })),
      checkFailedReason: `exception:${error instanceof Error ? error.name : typeof error}`,
    };
  }
}

/** Normalizes an untrusted hook-result array into the frozen expectation shape. */
export function normalizePromptPresenceExpectations(
  value: unknown,
): PromptPresenceExpectation[] | undefined {
  if (!Array.isArray(value) || value.length === 0) {
    return undefined;
  }
  const normalized: PromptPresenceExpectation[] = [];
  for (const item of value) {
    if (
      isRecord(item) &&
      typeof item.activationId === "string" &&
      typeof item.bodyText === "string" &&
      (typeof item.revision === "string" || typeof item.revision === "number") &&
      typeof item.bodyComplete === "boolean"
    ) {
      normalized.push({
        activationId: item.activationId,
        revision: item.revision,
        bodyText: item.bodyText,
        bodyChars: typeof item.bodyChars === "number" ? item.bodyChars : item.bodyText.length,
        bodyComplete: item.bodyComplete,
      });
    }
    // Invalid entries are dropped loudly at the producer site (validation warns);
    // here we keep the checker strict without inventing expectations.
  }
  return normalized.length > 0 ? normalized : undefined;
}

/** Truncation helper for bounded logging of oversized scanned regions. */
export function redactRegionForLog(regionText: string, limitBytes: number): string {
  return truncateToUtf8Limit(regionText, limitBytes);
}
