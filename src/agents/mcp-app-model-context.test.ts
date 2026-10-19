import { describe, expect, it, vi } from "vitest";
import type { SessionMcpRuntime } from "./agent-bundle-mcp-types.js";
import { INTERNAL_RUNTIME_CONTEXT_END } from "./internal-runtime-context.js";
import {
  clearMcpAppModelContextForView,
  getMcpAppModelContext,
  leaseMcpAppModelContextForTurn,
  removeMcpAppModelContextItem,
  revokeMcpAppModelContext,
  subscribeMcpAppModelContext,
  updateMcpAppModelContext,
} from "./mcp-app-model-context.js";

const runtime = () => ({ sessionId: "session-1" }) as SessionMcpRuntime;
const text = (value: string) => ({ content: [{ type: "text", text: value }] });

describe("MCP App model context", () => {
  it("replaces only one App instance and isolates runtimes", () => {
    const active = runtime();
    const sibling = runtime();
    const first = {};
    const second = {};
    updateMcpAppModelContext(active, first, text("old"));
    updateMcpAppModelContext(active, second, text("second"));
    updateMcpAppModelContext(active, first, text("new"));
    expect(leaseMcpAppModelContextForTurn({ runtime: sibling })).toBeUndefined();
    const lease = leaseMcpAppModelContextForTurn({ runtime: active });
    expect(lease?.modelContext).toEqual([text("new"), text("second")]);
    clearMcpAppModelContextForView(active, first);
    expect(getMcpAppModelContext(active, second)?.content).toEqual(text("second").content);
  });

  it("preserves rich host metadata but excludes it from actual model input", () => {
    const active = runtime();
    const view = {};
    updateMcpAppModelContext(active, view, {
      content: [
        {
          type: "text",
          text: "selection",
          _meta: {
            "openai/title": "Part",
            "openai/thumbnail": { src: "https://example.com/part.png" },
          },
          annotations: { audience: ["assistant"] },
        },
        {
          type: "image",
          data: "AA==",
          mimeType: "image/png",
          _meta: { "openai/title": "Drawing" },
        },
        { type: "resource_link", uri: "parts://bolt", name: "bolt", _meta: { private: true } },
        {
          type: "resource",
          resource: { uri: "parts://note", text: "note", _meta: { private: true } },
        },
      ],
      structuredContent: { selection: 1 },
    });
    expect(getMcpAppModelContext(active, view)?.content?.[0]?._meta).toHaveProperty(
      "openai/title",
      "Part",
    );
    const lease = leaseMcpAppModelContextForTurn({ runtime: active });
    expect(lease?.modelContext[0]?.content).toEqual([
      { type: "text", text: "selection", annotations: { audience: ["assistant"] } },
      { type: "image", data: "AA==", mimeType: "image/png" },
      { type: "resource_link", uri: "parts://bolt", name: "bolt" },
      { type: "resource", resource: { uri: "parts://note", text: "note" } },
    ]);
    expect(lease?.modelContext[0]?.structuredContent).toEqual({ selection: 1 });
    expect(lease?.context.text).not.toContain("_meta");
  });

  it("keeps idempotent update IDs and notifies user removals without accepting stale edits", () => {
    const active = runtime();
    const view = {};
    const changed = vi.fn();
    const stop = subscribeMcpAppModelContext(view, changed);
    const params = { content: [...text("one").content, ...text("two").content] };
    const first = updateMcpAppModelContext(active, view, params);
    expect(updateMcpAppModelContext(active, view, params)).toEqual(first);
    const id = first._meta["openai/modelContext"].updateId;
    const state = removeMcpAppModelContextItem(active, view, id, 0);
    expect(state?.content).toEqual(text("two").content);
    expect(state?.updateId).not.toBe(id);
    expect(() => removeMcpAppModelContextItem(active, view, id, 0)).toThrow("changed");
    expect(changed).toHaveBeenLastCalledWith(state);
    removeMcpAppModelContextItem(active, view, state!.updateId);
    expect(changed).toHaveBeenLastCalledWith(null);
    stop();
    updateMcpAppModelContext(active, view, text("new"));
    expect(changed).toHaveBeenLastCalledWith(null);
  });

  it("rejects audio, malformed blocks, structured arrays, and oversized context", () => {
    const active = runtime();
    const view = {};
    for (const params of [
      { content: [{ type: "audio", data: "AA==", mimeType: "audio/wav" }] },
      { content: [{ type: "image", data: 1 }] },
      { structuredContent: [] },
      text("x".repeat(6 * 1024 * 1024)),
    ]) {
      expect(() => updateMcpAppModelContext(active, view, params)).toThrow();
    }
  });

  it("keeps replacement subscriptions active after a stale unsubscribe", () => {
    const active = runtime();
    const view = {};
    const oldListener = vi.fn();
    const unsubscribeOld = subscribeMcpAppModelContext(view, oldListener);
    unsubscribeOld();
    const listener = vi.fn();
    const unsubscribe = subscribeMcpAppModelContext(view, listener);
    unsubscribeOld();
    updateMcpAppModelContext(active, view, text("replacement"));
    expect(listener).toHaveBeenCalledExactlyOnceWith(getMcpAppModelContext(active, view));
    expect(oldListener).not.toHaveBeenCalled();
    unsubscribe();
  });

  it("reserves each snapshot once, rolls back failures and preserves newer replacements", () => {
    const active = runtime();
    const view = {};
    updateMcpAppModelContext(active, view, text("leased"));
    const first = leaseMcpAppModelContextForTurn({ runtime: active });
    expect(leaseMcpAppModelContextForTurn({ runtime: active })).toBeUndefined();
    first?.rollback();
    const retry = leaseMcpAppModelContextForTurn({ runtime: active });
    expect(retry?.modelContext).toEqual([text("leased")]);
    updateMcpAppModelContext(active, view, text("newer"));
    retry?.commit();
    retry?.rollback();
    expect(leaseMcpAppModelContextForTurn({ runtime: active })?.modelContext).toEqual([
      text("newer"),
    ]);
  });

  it("clears only the sending snapshots after successful input custody", () => {
    const active = runtime();
    const view = {};
    const changed = vi.fn();
    subscribeMcpAppModelContext(view, changed);
    updateMcpAppModelContext(active, view, text("pending"));
    const lease = leaseMcpAppModelContextForTurn({ runtime: active });
    lease?.commit();
    lease?.commit();
    expect(getMcpAppModelContext(active, view)).toBeNull();
    expect(changed).toHaveBeenLastCalledWith(null);
  });

  it("revokes every instance and refuses updates after retirement", () => {
    const active = runtime();
    const view = {};
    const changed = vi.fn();
    subscribeMcpAppModelContext(view, changed);
    updateMcpAppModelContext(active, view, text("pending"));
    revokeMcpAppModelContext(active);
    expect(changed).toHaveBeenLastCalledWith(null);
    expect(() => updateMcpAppModelContext(active, view, text("stale"))).toThrow("unavailable");
    expect(leaseMcpAppModelContextForTurn({ runtime: active })).toBeUndefined();
  });

  it("escapes legacy delimiters without modifying the rich conversation data", () => {
    const active = runtime();
    const params = text("Literal " + INTERNAL_RUNTIME_CONTEXT_END);
    updateMcpAppModelContext(active, {}, params);
    const lease = leaseMcpAppModelContextForTurn({ runtime: active });
    expect(lease?.modelContext).toEqual([params]);
    expect(lease?.context.kind).toBe("conversation-data");
    expect(lease?.legacyText).not.toContain(INTERNAL_RUNTIME_CONTEXT_END);
  });
});
