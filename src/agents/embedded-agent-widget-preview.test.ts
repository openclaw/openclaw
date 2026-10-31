import { Type } from "typebox";
import { afterEach, expect, it, vi } from "vitest";
import type { ToolCall } from "../llm/types.js";
import { createEmbeddedAgentSessionEventHandler } from "./embedded-agent-subscribe.handlers.js";
import { createMessageUpdateContext } from "./embedded-agent-subscribe.handlers.messages.test-helpers.js";
import { makeAgentAssistantMessage } from "./test-helpers/agent-message-fixtures.js";

afterEach(() => vi.useRealTimers());

function subscriber(options: { caps?: string[]; core?: string[] } = {}) {
  const onAgentEvent = vi.fn();
  const ctx = createMessageUpdateContext({ onAgentEvent });
  ctx.params.clientCaps = options.caps ?? ["inline-widgets"];
  ctx.params.coreBuiltinToolNames = new Set(options.core ?? ["show_widget"]);
  return {
    ctx,
    receive: createEmbeddedAgentSessionEventHandler(ctx),
    events: () =>
      onAgentEvent.mock.calls
        .map(([event]) => event)
        .filter((event) => event.data.phase === "widget_preview"),
  };
}

it.each(["show_widget", "dispatch_action"])(
  "publishes decoded %s widget input before completion and owns strings before queued delivery",
  async (name) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1000);
    const { ctx, receive, events } = subscriber();
    ctx.params.toolSearchCatalogRef = {
      current: {
        counterScope: "widget-preview",
        searchCount: 0,
        describeCount: 0,
        callCount: 0,
        entries: [
          {
            id: "openclaw:core:show_widget",
            source: "openclaw",
            sourceName: "core",
            name: "show_widget",
            description: "Render widget",
            tool: {
              name: "show_widget",
              label: "Widget",
              description: "Render widget",
              parameters: Type.Object({}),
              execute: async () => ({ content: [], details: undefined }),
            },
          },
        ],
      },
    };
    let release!: () => void;
    ctx.state.pendingEventChain = new Promise<void>((resolve) => {
      release = resolve;
    });
    const html = `<section><h2>Café 雪 🦀</h2><p>${"Survey ".repeat(100)}</p><p>Drive C:\nNext line D:\tTabbed</p><p>quote: " and slash: \\</p></section>`;
    const input = { title: "Survey", widget_code: html };
    const json = JSON.stringify(
      name === "dispatch_action" ? { id: "openclaw:core:show_widget", args: input } : input,
    )
      .replace("雪", "\\u96ea")
      .replace("🦀", "\\ud83e\\udd80");
    const tool: ToolCall = {
      type: "toolCall",
      id: "widget-1",
      name,
      arguments: {},
      partialJson: "",
    };
    const message = makeAgentAssistantMessage({ content: [tool] });
    for (let end = 13; end < json.length; end += 13) {
      tool.partialJson = json.slice(0, end);
      void receive({
        type: "message_update",
        message,
        assistantMessageEvent: {
          type: "toolcall_delta",
          contentIndex: 0,
          delta: json.slice(end - 13, end),
          partial: message,
        },
      });
      vi.setSystemTime(Date.now() + 100);
    }
    const completeTool: ToolCall = { ...tool, id: "complete-widget", partialJson: json };
    const completeMessage = makeAgentAssistantMessage({ content: [completeTool] });
    void receive({
      type: "message_update",
      message: completeMessage,
      assistantMessageEvent: {
        type: "toolcall_delta",
        contentIndex: 0,
        delta: json,
        partial: completeMessage,
      },
    });
    delete tool.partialJson;
    tool.arguments = { title: "Unrelated mutated title", widget_code: "not the captured input" };
    release();
    await ctx.state.pendingEventChain;
    const snapshots = events().map((event) => event.data.preview);
    expect(snapshots.length).toBeGreaterThan(0);
    expect(
      snapshots.every((preview) => preview.title === "Survey" && html.startsWith(preview.html)),
    ).toBe(true);
    expect(snapshots[0].html).toContain("Café 雪 🦀");
    expect(snapshots.length).toBeLessThanOrEqual(Math.ceil(json.length / 512) + 1);
  },
);

it("only streams the admitted direct inline tool, retracts a late destination, and leaves final-only calls alone", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(1000);
  const html = `<p>${"x".repeat(600)}</p>`;
  for (const options of [{ caps: [] }, { core: [] }]) {
    const h = subscriber(options);
    const tool: ToolCall = {
      type: "toolCall",
      id: "widget",
      name: "show_widget",
      arguments: {},
      partialJson: JSON.stringify({ widget_code: html }),
    };
    const message = makeAgentAssistantMessage({ content: [tool] });
    await h.receive({
      type: "message_update",
      message,
      assistantMessageEvent: {
        type: "toolcall_delta",
        contentIndex: 0,
        delta: "",
        partial: message,
      },
    });
    expect(h.events()).toEqual([]);
  }
  const h = subscriber();
  const tool: ToolCall = {
    type: "toolCall",
    id: "widget",
    name: "show_widget",
    arguments: {},
    partialJson: JSON.stringify({ widget_code: html }),
  };
  const message = makeAgentAssistantMessage({ content: [tool] });
  await h.receive({
    type: "message_update",
    message,
    assistantMessageEvent: { type: "toolcall_delta", contentIndex: 0, delta: "", partial: message },
  });
  expect(h.events()).toHaveLength(1);
  tool.partialJson = JSON.stringify({ widget_code: "x".repeat(128 * 1024) });
  await h.receive({
    type: "message_update",
    message,
    assistantMessageEvent: { type: "toolcall_delta", contentIndex: 0, delta: "", partial: message },
  });
  expect(h.events()).toHaveLength(1); // Keep the last drawing when the input budget is exhausted.
  tool.arguments = { widget_code: html, presentation: { target: "node_panel" } };
  delete tool.partialJson;
  await h.receive({
    type: "message_update",
    message,
    assistantMessageEvent: {
      type: "toolcall_end",
      contentIndex: 0,
      toolCall: tool,
      partial: message,
    },
  });
  expect(h.events().at(-1)?.data.preview).toBeNull();
  const finalOnly = { ...tool, id: "final-only", arguments: { widget_code: html } };
  await h.receive({
    type: "message_update",
    message,
    assistantMessageEvent: {
      type: "toolcall_end",
      contentIndex: 0,
      toolCall: finalOnly,
      partial: message,
    },
  });
  expect(h.events()).toHaveLength(2);
});
