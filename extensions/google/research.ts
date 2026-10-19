import { createHash } from "node:crypto";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { resolveApiKeyForProvider } from "openclaw/plugin-sdk/provider-auth-runtime";
import { readProviderJsonResponse } from "openclaw/plugin-sdk/provider-http";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";

const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/interactions";
const AGENT = "deep-research-preview-04-2026";
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_REPORT_BYTES = 256 * 1024;
// Leave room for the feature job/request inside the host's 1 MiB retained-value limit.
const MAX_REPORT_JSON_BYTES = 384 * 1024;
const MAX_CITATIONS_JSON_BYTES = 64 * 1024;
const MAX_CITATIONS = 100;
const POLL_INTERVAL_MS = 5_000;

export type GoogleResearchHandle = { interactionId: string; profileId: string };
export type GoogleResearchInput =
  | { action: "describe" }
  | { action: "start"; question: string; output?: string; asOf?: string; profileId: string }
  | { action: "poll" | "cancel"; handle: GoogleResearchHandle };

export type GoogleResearchContext = {
  api: OpenClawPluginApi;
  agentId: string;
  signal: AbortSignal;
  assertCurrent: () => void;
  /** Provider owner binds the selected credential before any HTTP effect. */
  prepareAccount: (identity: string) => Promise<void>;
  /** Record an accepted native handle before normalizing or publishing its report. */
  recordReceipt: (handle: GoogleResearchHandle) => Promise<void>;
};

export type GoogleResearchCitation = {
  url: string;
  title?: string;
  /** UTF-8 byte offsets into report, not JavaScript string indices or source excerpts. */
  startByte?: number;
  endByte?: number;
};

export type GoogleResearchSnapshot = {
  state: "running" | "completed" | "partial" | "failed" | "cancelled" | "blocked" | "indeterminate";
  handle: GoogleResearchHandle;
  report?: string;
  citations: GoogleResearchCitation[];
  usageTokens?: number;
  reason?: string;
  retryAfterMs?: number;
};

export const googleResearchDescriptor = {
  version: 1,
  kind: "managed-research",
  provider: "google",
  agent: AGENT,
  authModes: ["api-key"],
  citationEvidence: "provider-attributed",
  storageRequired: true,
  hardBudgets: { model: false, search: false, tokens: false },
  idempotentStart: false,
};

/** No original provider/network error is retained: it may contain credentials or private traces. */
export class GoogleResearchError extends Error {
  constructor(
    message: string,
    readonly state: "blocked" | "failed" | "indeterminate",
    readonly handle?: GoogleResearchHandle,
    readonly retryAfterMs?: number,
    readonly httpStatus?: number,
  ) {
    super(message);
    this.name = "GoogleResearchError";
  }
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected an object.");
  }
  return value as Record<string, unknown>;
}

function array(value: unknown): unknown[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error("Expected an array.");
  }
  return value;
}

function boundedString(value: unknown, maxBytes: number): string {
  if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value, "utf8") > maxBytes) {
    throw new Error("Expected bounded, nonempty text.");
  }
  encodeURIComponent(value);
  return value;
}

function identifier(value: unknown): string {
  const text = boundedString(value, 2048);
  // oxlint-disable-next-line eslint/no-control-regex -- Provider identifiers must reject embedded control characters before URL encoding.
  if (/\s|[\u0000-\u001f\u007f]/u.test(text) || text === "." || text === "..") {
    throw new Error("Invalid identifier.");
  }
  return text;
}

function onlyKeys(value: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new Error("Unsupported research option.");
  }
}

export function parseGoogleResearchInput(value: unknown): GoogleResearchInput {
  try {
    const input = record(value);
    if (input.action === "describe") {
      onlyKeys(input, ["action"]);
      return { action: "describe" };
    }
    if (input.action === "start") {
      onlyKeys(input, ["action", "question", "output", "asOf", "profileId"]);
      return {
        action: "start",
        question: boundedString(input.question, 64 * 1024),
        profileId: boundedString(input.profileId, 512),
        ...(input.output === undefined ? {} : { output: boundedString(input.output, 8192) }),
        ...(input.asOf === undefined ? {} : { asOf: boundedString(input.asOf, 128) }),
      };
    }
    if (input.action === "poll" || input.action === "cancel") {
      onlyKeys(input, ["action", "handle"]);
      const handle = record(input.handle);
      onlyKeys(handle, ["interactionId", "profileId"]);
      return {
        action: input.action,
        handle: {
          interactionId: identifier(handle.interactionId),
          profileId: boundedString(handle.profileId, 512),
        },
      };
    }
  } catch {
    // Invalid caller values must not be echoed into an error or a paid request.
  }
  throw new GoogleResearchError("Invalid Google managed-research input.", "blocked");
}

function utf8Prefix(bytes: Buffer, limit: number): Buffer {
  let end = Math.min(bytes.length, limit);
  while (end > 0 && end < bytes.length && ((bytes[end] ?? 0) & 0xc0) === 0x80) {
    end--;
  }
  return bytes.subarray(0, end);
}

function jsonTextBytes(bytes: Buffer): number {
  return Buffer.byteLength(JSON.stringify(bytes.toString("utf8")), "utf8") - 2;
}

/** Bound encoded storage as well as display bytes without splitting UTF-8. */
function reportPrefix(bytes: Buffer, rawLimit: number, jsonLimit: number): Buffer {
  const retained = utf8Prefix(bytes, rawLimit);
  if (jsonTextBytes(retained) <= jsonLimit) {
    return retained;
  }
  let low = 0;
  let high = retained.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (jsonTextBytes(utf8Prefix(retained, middle)) <= jsonLimit) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return utf8Prefix(retained, low);
}

function citationUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 2048) {
    return undefined;
  }
  const url = URL.parse(value);
  return url &&
    ["https:", "http:"].includes(url.protocol) &&
    !url.username &&
    !url.password &&
    Buffer.byteLength(url.href, "utf8") <= 2048
    ? url.href
    : undefined;
}

function normalizeInteraction(
  interaction: Record<string, unknown>,
  handle: GoogleResearchHandle,
): GoogleResearchSnapshot {
  const states: Record<string, GoogleResearchSnapshot["state"]> = {
    queued: "running",
    in_progress: "running",
    requires_action: "blocked",
    completed: "completed",
    failed: "failed",
    cancelled: "cancelled",
    incomplete: "partial",
    budget_exceeded: "partial",
  };
  const status = interaction.status;
  const state =
    typeof status === "string" && Object.hasOwn(states, status) ? states[status] : undefined;
  if (!state) {
    throw new Error("Unknown interaction status.");
  }
  const result: GoogleResearchSnapshot = { state, handle, citations: [] };
  const report: string[] = [];
  let reportBytes = 0;
  let reportJsonBytes = 0;
  let citationJsonBytes = 2;
  let truncated = false;
  for (const rawStep of array(interaction.steps)) {
    const step = record(rawStep);
    if (step.type !== "model_output") {
      continue;
    }
    for (const rawContent of array(step.content)) {
      const content = record(rawContent);
      // Thoughts, tool inputs/results, and other modalities never become report/evidence.
      if (content.type !== "text") {
        continue;
      }
      if (typeof content.text !== "string") {
        throw new Error("Invalid model output text.");
      }
      if (!content.text) {
        continue;
      }
      const separator = report.length ? 2 : 0;
      const bytes = Buffer.from(content.text, "utf8");
      const available = Math.max(0, MAX_REPORT_BYTES - reportBytes - separator);
      const jsonSeparator = report.length ? 4 : 0;
      const retained = reportPrefix(
        bytes,
        available,
        Math.max(0, MAX_REPORT_JSON_BYTES - reportJsonBytes - jsonSeparator),
      );
      truncated ||= retained.length < bytes.length;
      if (!retained.length) {
        continue;
      }
      const offset = reportBytes + separator;
      report.push(retained.toString("utf8"));
      reportBytes = offset + retained.length;
      reportJsonBytes += jsonSeparator + jsonTextBytes(retained);
      for (const rawAnnotation of array(content.annotations)) {
        const annotation = record(rawAnnotation);
        if (annotation.type !== "url_citation") {
          continue;
        }
        const url = citationUrl(annotation.url);
        if (!url) {
          continue;
        }
        if (result.citations.length >= MAX_CITATIONS) {
          truncated = true;
          continue;
        }
        const citation: GoogleResearchCitation = { url };
        if (typeof annotation.title === "string") {
          citation.title = utf8Prefix(Buffer.from(annotation.title, "utf8"), 1024).toString("utf8");
        }
        const start = annotation.start_index;
        const end = annotation.end_index;
        if (
          typeof start === "number" &&
          typeof end === "number" &&
          Number.isSafeInteger(start) &&
          Number.isSafeInteger(end) &&
          start >= 0 &&
          end > start &&
          end <= retained.length &&
          ((retained[start] ?? 0) & 0xc0) !== 0x80 &&
          (end === retained.length || ((retained[end] ?? 0) & 0xc0) !== 0x80)
        ) {
          citation.startByte = offset + start;
          citation.endByte = offset + end;
        }
        const citationSize =
          Buffer.byteLength(JSON.stringify(citation), "utf8") + (result.citations.length ? 1 : 0);
        if (citationJsonBytes + citationSize > MAX_CITATIONS_JSON_BYTES) {
          truncated = true;
          continue;
        }
        citationJsonBytes += citationSize;
        // The API attributes generated text; it supplies no fetched source excerpt.
        result.citations.push(citation);
      }
    }
  }
  if (report.length) {
    result.report = report.join("\n\n");
  }
  if (interaction.usage !== undefined) {
    const total = record(interaction.usage).total_tokens;
    if (total !== undefined) {
      if (typeof total !== "number" || !Number.isSafeInteger(total) || total < 0) {
        throw new Error("Invalid usage total.");
      }
      result.usageTokens = total;
    }
  }
  // Do not forward diagnostic messages: they can include prompts or private tool traces.
  const errorCount = array(interaction.errors).length;
  if (status === "requires_action") {
    result.reason =
      "Google requires additional input; this adapter does not support interactive planning.";
  } else if (status === "failed") {
    result.reason = `Google research failed (${errorCount} provider diagnostics).`;
  } else if (status === "incomplete" || status === "budget_exceeded") {
    result.reason = "Google returned an incomplete research result.";
  }
  if (result.state === "running") {
    result.retryAfterMs = POLL_INTERVAL_MS;
  }
  if (truncated || (result.state === "completed" && !result.report)) {
    if (result.state === "completed") {
      result.state = "partial";
    }
    result.reason = truncated
      ? "The report or citations exceeded the adapter output limit; this snapshot is truncated."
      : "Google completed without a text report.";
  }
  return result;
}

function retryAfter(response: Response): number {
  const header = response.headers.get("retry-after");
  if (!header) {
    return POLL_INTERVAL_MS;
  }
  const delay = /^\d+(?:\.\d+)?$/u.test(header)
    ? Number(header) * 1000
    : Date.parse(header) - Date.now();
  return Number.isFinite(delay) && delay >= 0 ? Math.min(delay, 3_600_000) : POLL_INTERVAL_MS;
}

export async function executeGoogleResearch(
  input: GoogleResearchInput,
  context: GoogleResearchContext,
): Promise<typeof googleResearchDescriptor | GoogleResearchSnapshot> {
  if (input.action === "describe") {
    return googleResearchDescriptor;
  }
  context.signal.throwIfAborted();
  context.assertCurrent();
  const profileId = input.action === "start" ? input.profileId : input.handle.profileId;
  let handle = input.action === "start" ? undefined : input.handle;
  let auth: Awaited<ReturnType<typeof resolveApiKeyForProvider>>;
  try {
    auth = await resolveApiKeyForProvider({
      provider: "google",
      profileId,
      lockedProfile: true,
      cfg: context.api.config,
      agentDir: context.api.runtime.agent.resolveAgentDir(context.api.config, context.agentId),
      signal: context.signal,
    });
  } catch {
    throw new GoogleResearchError(
      "Unable to resolve the selected Google API-key profile.",
      "blocked",
      handle,
    );
  }
  if (
    auth.mode !== "api-key" ||
    auth.profileId !== profileId ||
    !auth.apiKey?.trim() ||
    /[^\x21-\x7e]/u.test(auth.apiKey) ||
    auth.apiKey.trimStart().startsWith("{")
  ) {
    throw new GoogleResearchError(
      "Google research requires the exact selected API-key profile.",
      "blocked",
      handle,
    );
  }
  // Never pass through the ordinary Gemini OAuth/key parser or configurable base URL.
  const headers = new Headers({ "x-goog-api-key": auth.apiKey });
  let body: string | undefined;
  let url = ENDPOINT;
  if (input.action === "start") {
    const prompt = [
      input.question,
      ...(input.output ? [`Requested output:\n${input.output}`] : []),
      ...(input.asOf ? [`Research as of: ${input.asOf}`] : []),
    ].join("\n\n");
    headers.set("Content-Type", "application/json");
    body = JSON.stringify({
      agent: AGENT,
      input: prompt,
      background: true,
      store: true,
      tools: [{ type: "google_search" }, { type: "url_context" }],
      agent_config: { type: "deep-research", collaborative_planning: false },
    });
  } else {
    url += `/${encodeURIComponent(input.handle.interactionId)}`;
    if (input.action === "cancel") {
      url += "/cancel";
    }
  }
  let attempted = false;
  try {
    context.assertCurrent();
    await context.prepareAccount(createHash("sha256").update(auth.apiKey).digest("hex"));
    context.assertCurrent();

    const { response, release } = await fetchWithSsrFGuard({
      url,
      init: {
        method: input.action === "poll" ? "GET" : "POST",
        headers,
        ...(body === undefined ? {} : { body }),
      },
      signal: context.signal,
      timeoutMs: 60_000,
      mode: "strict",
      requireHttps: true,
      maxRedirects: 0,
      capture: false,
      policy: { allowedHostnames: ["generativelanguage.googleapis.com"] },
      beforeRequest: () => {
        context.signal.throwIfAborted();
        context.assertCurrent();
        attempted = true;
      },
    });
    try {
      if (response.status !== 200) {
        const uncertain =
          input.action !== "start" ||
          response.status >= 500 ||
          response.status === 408 ||
          response.status < 400;
        throw new GoogleResearchError(
          `Google research ${input.action} returned HTTP ${response.status}.`,
          response.status === 401 || response.status === 403
            ? "blocked"
            : uncertain
              ? "indeterminate"
              : "failed",
          handle,
          input.action === "poll" && (response.status === 429 || response.status >= 500)
            ? retryAfter(response)
            : undefined,
          response.status,
        );
      }
      const interaction = record(
        await readProviderJsonResponse<unknown>(response, "Google research", {
          maxBytes: MAX_RESPONSE_BYTES,
          requestHeaders: headers,
        }),
      );
      const interactionId = identifier(interaction.id);
      if (handle && handle.interactionId !== interactionId) {
        throw new Error("Mismatched interaction ID.");
      }
      handle = { interactionId, profileId };
      await context.recordReceipt(handle);
      context.assertCurrent();
      return normalizeInteraction(interaction, handle);
    } finally {
      await release();
    }
  } catch (error) {
    if (error instanceof GoogleResearchError) {
      throw error;
    }
    // Once a create reached the transport, absence of a usable response cannot prove failure.
    // There is no documented idempotency key or client-key reconciliation; never retry here.
    throw new GoogleResearchError(
      attempted
        ? "Google research outcome is indeterminate; do not repeat a start request."
        : "Google research request was not sent.",
      attempted ? "indeterminate" : "blocked",
      handle,
      input.action === "poll" && attempted ? POLL_INTERVAL_MS : undefined,
    );
  }
}
