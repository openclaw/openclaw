import { parseStreamingJson } from "@openclaw/ai/internal/runtime";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { emitAgentEvent } from "../infra/agent-events.js";
import {
  WIDGET_INPUT_PREVIEW_MAX_CHARS,
  type WidgetInputPreviewEvent,
} from "../shared/widget-input-preview.js";
import { runBestEffortCallback } from "./embedded-agent-subscribe.callback.js";
import type { EmbeddedAgentSubscribeContext } from "./embedded-agent-subscribe.handlers.types.js";
import { findToolSearchCatalogEntry } from "./tool-search-catalog.js";
import { readToolSearchCallArgs } from "./tool-search-request.js";
import type { ToolSearchCatalogRef } from "./tool-search-types.js";

const MIN_PREVIEW_INTERVAL_MS = 100;
const MIN_PREVIEW_ADVANCE_CHARS = 512;
const MAX_PREVIEW_SNAPSHOTS = 128;
const MAX_PREVIEW_CALLS = 8;

type PreviewState = { checkedAt: number; checkedLength: number; snapshots: number; shown: boolean };

function inlineHtmlArguments(args: Record<string, unknown>): boolean {
  const target = asOptionalRecord(args.presentation)?.target;
  const report = asOptionalRecord(args.report);
  return (
    (args.kind === undefined || args.kind === "html") &&
    (args.report === undefined ||
      args.report === null ||
      (report !== undefined && Object.keys(report).length === 0)) &&
    (target === undefined || target === "assistant_message")
  );
}

/** Capture strings before serialized subscribers can observe a mutated provider buffer. */
export function createWidgetInputPreviewCapture() {
  const calls = new Map<string, PreviewState>();
  return {
    clear: () => calls.clear(),
    capture(
      value: unknown,
      catalogRef?: ToolSearchCatalogRef,
    ): WidgetInputPreviewEvent | undefined {
      const event = asOptionalRecord(value);
      if (event?.type !== "toolcall_delta" && event?.type !== "toolcall_end") {
        return undefined;
      }
      const partial = asOptionalRecord(event.partial);
      const block =
        typeof event.contentIndex === "number" && Array.isArray(partial?.content)
          ? asOptionalRecord(partial.content[event.contentIndex])
          : undefined;
      const tool = event.type === "toolcall_end" ? asOptionalRecord(event.toolCall) : block;
      if (
        tool?.type !== "toolCall" ||
        (tool.name !== "show_widget" && tool.name !== "dispatch_action") ||
        typeof tool.id !== "string"
      ) {
        return undefined;
      }
      const widgetArguments = (args: Record<string, unknown> | undefined) => {
        if (tool.name === "show_widget") {
          return args;
        }
        const catalog = catalogRef?.current;
        if (!catalog || !args) {
          return undefined;
        }
        try {
          const { id, input } = readToolSearchCallArgs(args, catalog);
          const entry = findToolSearchCatalogEntry(catalog, id);
          return entry.source === "openclaw" &&
            entry.name === "show_widget" &&
            entry.sourceName === "core"
            ? asOptionalRecord(input)
            : undefined;
        } catch {
          // Incomplete streamed ids are not catalog lookups yet.
          return undefined;
        }
      };
      const toolCallId = tool.id;
      const previous = calls.get(toolCallId);
      const retract = (): WidgetInputPreviewEvent | undefined => {
        if (!previous?.shown) {
          return undefined;
        }
        previous.shown = false;
        return { phase: "widget_preview", name: "show_widget", toolCallId, preview: null };
      };
      if (event.type === "toolcall_end") {
        calls.delete(toolCallId);
        const args = widgetArguments(asOptionalRecord(tool.arguments));
        return !args || !inlineHtmlArguments(args) ? retract() : undefined;
      }
      const json = typeof block?.partialJson === "string" ? block.partialJson : "";
      if (!json || json.length > WIDGET_INPUT_PREVIEW_MAX_CHARS) {
        return undefined;
      }
      if (!previous && calls.size >= MAX_PREVIEW_CALLS) {
        return undefined;
      }
      const state = previous ?? { checkedAt: 0, checkedLength: 0, snapshots: 0, shown: false };
      const now = Date.now();
      // Bound work before parsing cumulative JSON. Tiny token fragments do no scans.
      if (
        state.snapshots >= MAX_PREVIEW_SNAPSHOTS ||
        (state.checkedAt > 0 && now - state.checkedAt < MIN_PREVIEW_INTERVAL_MS) ||
        (json.length >= state.checkedLength &&
          json.length - state.checkedLength < MIN_PREVIEW_ADVANCE_CHARS)
      ) {
        return undefined;
      }
      calls.set(toolCallId, state);
      state.checkedAt = now;
      state.checkedLength = json.length;
      state.snapshots += 1;
      const args = widgetArguments(parseStreamingJson(json, { preserveValidControlEscapes: true }));
      if (!args || !inlineHtmlArguments(args)) {
        return retract();
      }
      if (typeof args.widget_code !== "string" || !args.widget_code) {
        return undefined;
      }
      state.shown = true;
      return {
        phase: "widget_preview",
        name: "show_widget",
        toolCallId,
        preview: {
          title: typeof args.title === "string" ? args.title.slice(0, 256) : "",
          html: args.widget_code,
        },
      };
    },
  };
}

export function emitWidgetInputPreview(
  ctx: EmbeddedAgentSubscribeContext,
  data: WidgetInputPreviewEvent | undefined,
): void {
  if (!data || ctx.state.unsubscribed || ctx.params.isTerminalAborted?.()) {
    return;
  }
  emitAgentEvent({ runId: ctx.params.runId, stream: "tool", data });
  runBestEffortCallback({
    label: "widget input preview",
    log: ctx.log,
    callback: () => ctx.params.onAgentEvent?.({ stream: "tool", data }),
  });
}
