/**
 * Owns the model-facing snapshot result shape (untrusted-content wrapping,
 * caps, dialog states) and attaches fresh page state to actions that changed
 * the page document so the model does not need a follow-up snapshot call.
 */
import type { AgentToolResult } from "openclaw/plugin-sdk/agent-core";
import { imageResultFromFile } from "openclaw/plugin-sdk/channel-actions";
import {
  readNonNegativeIntegerParam,
  readPositiveIntegerParam,
} from "openclaw/plugin-sdk/param-readers";
import { getRuntimeConfig } from "openclaw/plugin-sdk/runtime-config-snapshot";
import {
  formatErrorMessage,
  truncateSanitizedExternalContent,
  wrapExternalContent,
} from "openclaw/plugin-sdk/security-runtime";
import {
  normalizeOptionalString,
  readStringValue,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { DEFAULT_MAX_LIVE_TOOL_RESULT_CHARS } from "openclaw/plugin-sdk/text-utility-runtime";
import { textResult } from "openclaw/plugin-sdk/tool-results";
import { resolveRuntimeImageSanitization } from "./browser-tool.runtime.js";
import type { BrowserClientTarget } from "./browser/client-request.js";
import { browserSnapshot } from "./browser/client.js";
import {
  DEFAULT_AI_SNAPSHOT_MAX_CHARS,
  DEFAULT_BROWSER_SNAPSHOT_TIMEOUT_MS,
} from "./browser/constants.js";
import { finalizeRoleSnapshot, findRoleSnapshotLineRef } from "./browser/pw-role-snapshot.js";
import { neutralizeMediaDirectives } from "./browser/vision.js";

const BROWSER_EXTERNAL_JSON_TRUNCATION_MARKERS = {
  snapshot: "\n[truncated — retry with a smaller maxChars or limit]",
  console: "\n[truncated — retry with a stricter level or targetId]",
  requests: "\n[truncated — retry with a narrower filter or smaller limit]",
  errors: "\n[truncated — retry with a smaller limit]",
  tabs: "\n[truncated — retry with action=snapshot and a specific targetId]",
  act: "\n[truncated — inspect the affected targetId with action=snapshot]",
  download: "\n[truncated — retry with a specific targetId and download ref]",
};

type BrowserExternalJsonKind = keyof typeof BROWSER_EXTERNAL_JSON_TRUNCATION_MARKERS;

function truncateBrowserToolText(value: string, marker: string, maxChars: number) {
  const bounded = truncateSanitizedExternalContent(value, maxChars);
  if (!bounded.truncated) {
    return bounded;
  }
  if (marker.length > maxChars) {
    return bounded;
  }
  const marked = truncateSanitizedExternalContent(value, Math.max(0, maxChars - marker.length));
  return {
    text: `${marked.text}${marker}`,
    truncated: true,
  };
}

/** Bound and wrap browser-originated text before it reaches the model. */
export function wrapBrowserExternalText(params: {
  value: string;
  marker: string;
  includeWarning: boolean;
  maxChars?: number;
  prefix?: string;
}) {
  const wrap = (value: string) =>
    wrapExternalContent(value, {
      source: "browser",
      includeWarning: params.includeWarning,
    });
  const prefix = params.prefix ? `${params.prefix}\n` : "";
  const wrapperOverhead = prefix.length + wrap("").length;
  let maxInnerChars = Math.max(
    0,
    Math.min(params.maxChars ?? Infinity, DEFAULT_MAX_LIVE_TOOL_RESULT_CHARS - wrapperOverhead),
  );
  const value = neutralizeMediaDirectives(params.value);
  let bounded = truncateBrowserToolText(value, params.marker, maxInnerChars);
  let wrappedText = prefix + wrap(bounded.text);
  if (wrappedText.length > DEFAULT_MAX_LIVE_TOOL_RESULT_CHARS) {
    maxInnerChars = Math.max(
      0,
      maxInnerChars - (wrappedText.length - DEFAULT_MAX_LIVE_TOOL_RESULT_CHARS),
    );
    bounded = truncateBrowserToolText(value, params.marker, maxInnerChars);
    wrappedText = prefix + wrap(bounded.text);
  }
  return { text: wrappedText, boundedText: bounded.text, truncated: bounded.truncated };
}

/** Wrap page-controlled JSON payloads as untrusted browser content. */
export function wrapBrowserExternalJson(params: {
  kind: BrowserExternalJsonKind;
  payload: unknown;
  includeWarning?: boolean;
}): { wrappedText: string; truncated: boolean; safeDetails: Record<string, unknown> } {
  const serialized =
    JSON.stringify(
      params.payload,
      (_key: string, value: unknown) =>
        typeof value === "string" ? neutralizeMediaDirectives(value) : value,
      2,
    ) ?? "null";
  // Browser tabs, snapshots, and console output are page-controlled data. Keep
  // text wrapped even when details carry the structured fields for callers.
  const wrapped = wrapBrowserExternalText({
    value: serialized,
    marker: BROWSER_EXTERNAL_JSON_TRUNCATION_MARKERS[params.kind],
    includeWarning: params.includeWarning ?? true,
  });
  return {
    wrappedText: wrapped.text,
    truncated: wrapped.truncated,
    safeDetails: {
      ok: true,
      externalContent: {
        untrusted: true,
        source: "browser",
        kind: params.kind,
        wrapped: true,
      },
    },
  };
}

/** Keep debug log counts aligned with complete records inside the output budget. */
export function formatBrowserDebugLogResult(
  kind: "requests" | "errors",
  result: { ok: true; targetId: string; url?: string },
  entries: unknown[],
  limit: number,
): AgentToolResult<unknown> {
  const total = entries.length;
  let records = entries.slice(-limit);
  const details = () => ({
    ok: result.ok,
    targetId: result.targetId,
    url: result.url,
    total,
    returned: records.length,
    truncated: records.length < total,
  });
  const wrap = () =>
    wrapBrowserExternalJson({
      kind,
      payload: { ...details(), [kind]: records },
      includeWarning: false,
    });
  let wrapped = wrap();
  // Whole JSON records have independent serialized and sanitized lengths, so
  // dropping older records can only reduce the space needed by the suffix.
  if (wrapped.truncated && records.length > 0) {
    const initialRecords = records;
    let lower = 1;
    let upper = initialRecords.length;
    while (lower < upper) {
      const middle = Math.floor((lower + upper) / 2);
      records = initialRecords.slice(middle);
      wrapped = wrap();
      if (wrapped.truncated) {
        lower = middle + 1;
      } else {
        upper = middle;
      }
    }
    if (records.length !== initialRecords.length - lower) {
      records = initialRecords.slice(lower);
      wrapped = wrap();
    }
  }
  return textResult(wrapped.wrappedText, {
    ...wrapped.safeDetails,
    ...details(),
    truncated: records.length < total || wrapped.truncated,
  });
}

function isAriaRefsUnsupportedError(err: unknown): boolean {
  const msg = String(err).toLowerCase();
  return msg.includes("refs=aria") && msg.includes("not support");
}

export async function executeSnapshotAction(params: {
  input: Record<string, unknown>;
  target: BrowserClientTarget;
  profile?: string;
  signal?: AbortSignal;
  onTabActivity?: (targetId: string | undefined) => void | Promise<void>;
}): Promise<AgentToolResult<unknown>> {
  const { input, target, profile } = params;
  const snapshotDefaults = getRuntimeConfig().browser?.snapshotDefaults;
  const format: "ai" | "aria" | undefined =
    input.snapshotFormat === "ai" ? "ai" : input.snapshotFormat === "aria" ? "aria" : undefined;
  const formatExplicit = format !== undefined;
  const mode: "efficient" | undefined =
    input.mode === "efficient" || (!formatExplicit && snapshotDefaults?.mode === "efficient")
      ? "efficient"
      : undefined;
  const labels = typeof input.labels === "boolean" ? input.labels : undefined;
  const urls = typeof input.urls === "boolean" ? input.urls : undefined;
  const refs: "aria" | "role" | undefined =
    input.refs === "aria" || input.refs === "role" ? input.refs : undefined;
  const hasMaxChars = Object.hasOwn(input, "maxChars");
  const targetId = normalizeOptionalString(input.targetId);
  const limit = readPositiveIntegerParam(input, "limit", {
    message: "limit must be a positive integer.",
  });
  const maxCharsRaw = readNonNegativeIntegerParam(input, "maxChars", {
    message: "maxChars must be a non-negative integer.",
  });
  const maxChars = maxCharsRaw !== undefined && maxCharsRaw > 0 ? maxCharsRaw : undefined;
  const interactive = typeof input.interactive === "boolean" ? input.interactive : undefined;
  const compact = typeof input.compact === "boolean" ? input.compact : undefined;
  const depth = readNonNegativeIntegerParam(input, "depth", {
    message: "depth must be a non-negative integer.",
  });
  const selector = normalizeOptionalString(input.selector);
  const frame = normalizeOptionalString(input.frame);
  const resolvedMaxChars = hasMaxChars
    ? maxChars
    : format === "ai" && mode !== "efficient"
      ? DEFAULT_AI_SNAPSHOT_MAX_CHARS
      : undefined;
  // AI snapshots have a compact default cap; ARIA snapshots keep full structure
  // unless maxChars is explicit, because agents often need complete node refs.
  const snapshotTimeoutMs =
    readPositiveIntegerParam(input, "timeoutMs", {
      message: "timeoutMs must be a positive integer.",
    }) ?? DEFAULT_BROWSER_SNAPSHOT_TIMEOUT_MS;
  const snapshotQuery = {
    ...(format ? { format } : {}),
    targetId,
    limit,
    ...(typeof resolvedMaxChars === "number" ? { maxChars: resolvedMaxChars } : {}),
    refs,
    interactive,
    compact,
    depth,
    selector,
    frame,
    labels,
    urls,
    mode,
    timeoutMs: snapshotTimeoutMs,
  };
  let refsFallback: "role" | undefined;
  const readSnapshot = async (query: typeof snapshotQuery) =>
    await browserSnapshot(target, {
      ...query,
      profile,
      signal: params.signal,
    });
  let snapshot: Awaited<ReturnType<typeof browserSnapshot>>;
  try {
    snapshot = await readSnapshot(snapshotQuery);
  } catch (err) {
    if (refs !== "aria" || !isAriaRefsUnsupportedError(err)) {
      throw err;
    }
    refsFallback = "role";
    snapshot = await readSnapshot({ ...snapshotQuery, refs: "role" });
  }
  await params.onTabActivity?.(readStringValue(snapshot.targetId) ?? targetId);
  const identity = { format: snapshot.format, targetId: snapshot.targetId, url: snapshot.url };
  const dialogState = {
    ...(snapshot.blockedByDialog ? { blockedByDialog: true } : {}),
    ...(snapshot.browserState !== undefined ? { browserState: snapshot.browserState } : {}),
  };
  const aiMetadata =
    snapshot.format === "ai"
      ? {
          labels: snapshot.labels,
          labelsCount: snapshot.labelsCount,
          labelsSkipped: snapshot.labelsSkipped,
          annotations: snapshot.annotations,
          imagePath: snapshot.imagePath,
          imageType: snapshot.imageType,
          refsFallback,
        }
      : {};
  const externalContent = {
    untrusted: true,
    source: "browser",
    kind: "snapshot",
    format: snapshot.format,
    wrapped: true,
  };
  const finishSnapshot = async (
    text: string,
    details: Record<string, unknown>,
  ): Promise<AgentToolResult<unknown>> => {
    if (labels && snapshot.format === "ai" && snapshot.imagePath) {
      return await imageResultFromFile({
        label: "browser:snapshot",
        path: snapshot.imagePath,
        extraText: text,
        // Keep model-only screenshots out of automatic channel delivery.
        details: { ...details, media: { outbound: false } },
        imageSanitization: resolveRuntimeImageSanitization(),
      });
    }
    return textResult(text, details);
  };
  const query = normalizeOptionalString(input.query);
  if (query && !snapshot.blockedByDialog) {
    const tokens = query.toLowerCase().split(/\s+/);
    const source =
      snapshot.format === "ai"
        ? snapshot.snapshot
        : snapshot.nodes
            .map(
              (node) =>
                `- ${node.role} ${JSON.stringify(node.name)} [ref=${node.ref}]${node.value ? ` value=${JSON.stringify(node.value)}` : ""}${node.description ? ` description=${JSON.stringify(node.description)}` : ""}`,
            )
            .join("\n");
    const matches = source.split("\n").filter((line) => {
      const lower = line.toLowerCase();
      return tokens.every((token) => lower.includes(token));
    });
    const matchedText = matches.join("\n");
    const matchCount = matches.length;
    const summary = matchCount
      ? `${matchCount} matching line(s) in the returned snapshot${snapshot.truncated ? " (source truncated)" : ""}.`
      : "No matching lines in the returned snapshot. Refine the query or take a broader snapshot.";
    const wrapped = wrapBrowserExternalText({
      value: matchedText,
      marker: BROWSER_EXTERNAL_JSON_TRUNCATION_MARKERS.snapshot,
      maxChars: maxChars ?? DEFAULT_AI_SNAPSHOT_MAX_CHARS,
      includeWarning: true,
      prefix: summary,
    });
    const snapshotRefs =
      snapshot.format === "ai"
        ? (snapshot.refs ?? {})
        : Object.fromEntries(
            snapshot.nodes.map((node) => [node.ref, { role: node.role, name: node.name }]),
          );
    const filtered = finalizeRoleSnapshot({ snapshot: wrapped.boundedText, refs: snapshotRefs });
    const newElements = filtered.snapshot
      .split("\n")
      .filter((line) => line.endsWith(" [new]") && findRoleSnapshotLineRef(line)).length;
    return await finishSnapshot(wrapped.text, {
      ok: snapshot.ok,
      ...identity,
      matchCount,
      stats: filtered.stats,
      refs: filtered.stats.refs,
      ...(snapshot.format === "ai" && snapshot.newElements !== undefined ? { newElements } : {}),
      truncated: snapshot.truncated || wrapped.truncated || undefined,
      ...dialogState,
      ...aiMetadata,
      externalContent,
    });
  }
  if (snapshot.format === "ai") {
    if (snapshot.blockedByDialog) {
      const wrapped = wrapBrowserExternalJson({
        kind: "snapshot",
        payload: {
          ...identity,
          ...dialogState,
        },
      });
      return textResult(wrapped.wrappedText, {
        ...wrapped.safeDetails,
        ...identity,
        ...dialogState,
      });
    }
    const boundedSnapshot = wrapBrowserExternalText({
      value: snapshot.snapshot ?? "",
      marker: BROWSER_EXTERNAL_JSON_TRUNCATION_MARKERS.snapshot,
      includeWarning: true,
    });
    return await finishSnapshot(boundedSnapshot.text, {
      ok: true,
      ...identity,
      truncated: snapshot.truncated || boundedSnapshot.truncated ? true : undefined,
      newElements: snapshot.newElements,
      stats: snapshot.stats,
      refs: snapshot.refs ? Object.keys(snapshot.refs).length : undefined,
      ...aiMetadata,
      ...dialogState,
      externalContent,
    });
  }
  {
    const wrapped = wrapBrowserExternalJson({
      kind: "snapshot",
      payload: snapshot,
    });
    return textResult(wrapped.wrappedText, {
      ...wrapped.safeDetails,
      ...identity,
      nodeCount: snapshot.nodes.length,
      ...dialogState,
      externalContent,
    });
  }
}

/**
 * Attach fresh page state to the result of an action that changed the page
 * document (navigate, act that navigated). The model can act on the new page
 * without a follow-up snapshot call. The inline state uses the efficient
 * interactive tier so the unsolicited payload stays bounded on every profile
 * (mode=efficient forces the capped ai format even where the profile default
 * would be an uncapped aria tree); a full snapshot stays one explicit call away.
 */
export async function appendNavigatedPageState(params: {
  result: AgentToolResult<unknown>;
  targetId?: string;
  target: BrowserClientTarget;
  profile?: string;
  signal?: AbortSignal;
}): Promise<AgentToolResult<unknown>> {
  let snapshot: AgentToolResult<unknown>;
  try {
    snapshot = await executeSnapshotAction({
      input: { targetId: params.targetId, mode: "efficient" },
      target: params.target,
      profile: params.profile,
      signal: params.signal,
    });
  } catch (err) {
    // Cancellation must keep aborting the whole tool call; only genuine
    // snapshot failures degrade, because page state is feedback on an
    // already-successful mutation and must not fail the action.
    params.signal?.throwIfAborted();
    if (err instanceof Error && err.name === "AbortError") {
      throw err;
    }
    const reason = wrapExternalContent(neutralizeMediaDirectives(formatErrorMessage(err)), {
      source: "browser",
      includeWarning: false,
    });
    return {
      ...params.result,
      content: [
        ...params.result.content,
        {
          type: "text",
          text: `[page snapshot unavailable: ${reason}. Use action=snapshot to read the page.]`,
        },
      ],
    };
  }
  const baseDetails =
    params.result.details && typeof params.result.details === "object"
      ? (params.result.details as Record<string, unknown>)
      : {};
  return {
    content: [...params.result.content, ...snapshot.content],
    details: { ...baseDetails, pageState: snapshot.details },
  };
}
