import { describe, expect, it, vi } from "vitest";
import type { HookEntry } from "../../hooks/types.js";
import {
  OPENCLAW_TO_SDK_EVENT,
  buildSdkHooks,
  type InvokeOpenClawHook,
} from "./hooks-adapter.js";

// Minimal HookEntry factory — we only touch `metadata.events` in the
// adapter, so the rest is filler to satisfy the type.
function makeEntry(name: string, events: string[]): HookEntry {
  return {
    hook: {
      name,
      description: `test hook ${name}`,
      source: "openclaw-bundled",
      filePath: `/fake/${name}/HOOK.md`,
      baseDir: `/fake/${name}`,
      handlerPath: `/fake/${name}/handler.js`,
    },
    frontmatter: {},
    metadata: { events },
  };
}

describe("buildSdkHooks", () => {
  it("maps well-known OpenClaw events to SDK events", () => {
    const invoke = vi.fn<InvokeOpenClawHook>(async () => undefined);
    const warn = vi.fn();
    const entries = [makeEntry("a", ["session:start"]), makeEntry("b", ["tool:pre", "tool:post"])];

    const result = buildSdkHooks({ entries, invoke, warn });

    expect(Object.keys(result).toSorted()).toEqual(["PostToolUse", "PreToolUse", "SessionStart"]);
    expect(result.SessionStart?.[0]?.hooks).toHaveLength(1);
    expect(result.PreToolUse?.[0]?.hooks).toHaveLength(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it("groups multiple hooks on the same SDK event into one matcher", () => {
    const invoke = vi.fn<InvokeOpenClawHook>(async () => undefined);
    const entries = [
      makeEntry("a", ["tool:pre"]),
      makeEntry("b", ["tool:pre"]),
      makeEntry("c", ["tool:pre"]),
    ];

    const result = buildSdkHooks({ entries, invoke });

    expect(result.PreToolUse).toHaveLength(1);
    expect(result.PreToolUse?.[0]?.hooks).toHaveLength(3);
  });

  it("warns (does not silently drop) on unknown OpenClaw event names", () => {
    const invoke = vi.fn<InvokeOpenClawHook>(async () => undefined);
    const warn = vi.fn();
    const entries = [makeEntry("a", ["some:custom:event", "also-unknown"])];

    const result = buildSdkHooks({ entries, invoke, warn });

    expect(Object.keys(result)).toHaveLength(0);
    expect(warn).toHaveBeenCalledTimes(1);
    // Unknown events are listed alphabetically so the message is stable.
    expect(warn.mock.calls[0]?.[0]).toContain("also-unknown");
    expect(warn.mock.calls[0]?.[0]).toContain("some:custom:event");
  });

  it("returns { continue: true } by default when invoke yields undefined", async () => {
    const invoke = vi.fn<InvokeOpenClawHook>(async () => undefined);
    const entries = [makeEntry("a", ["session:start"])];
    const result = buildSdkHooks({ entries, invoke });

    const cb = result.SessionStart?.[0]?.hooks[0];
    expect(cb).toBeDefined();
    const abort = new AbortController();
    const output = await cb!(
      {
        session_id: "s1",
        transcript_path: "/tmp/t.jsonl",
        cwd: "/tmp",
        hook_event_name: "SessionStart",
      } as unknown as Parameters<NonNullable<typeof cb>>[0],
      undefined,
      { signal: abort.signal },
    );
    expect(output).toEqual({ continue: true });
  });

  it("passes the mapped SDK event and entry through to invoke", async () => {
    const invoke = vi.fn<InvokeOpenClawHook>(async () => undefined);
    const entries = [makeEntry("a", ["user:prompt"])];
    const result = buildSdkHooks({ entries, invoke });

    const cb = result.UserPromptSubmit?.[0]?.hooks[0];
    const abort = new AbortController();
    await cb!(
      {
        session_id: "s1",
        transcript_path: "/tmp/t.jsonl",
        cwd: "/tmp",
        hook_event_name: "UserPromptSubmit",
      } as unknown as Parameters<NonNullable<typeof cb>>[0],
      undefined,
      { signal: abort.signal },
    );
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke.mock.calls[0]?.[0]?.sdkEvent).toBe("UserPromptSubmit");
    expect(invoke.mock.calls[0]?.[0]?.entry).toBe(entries[0]);
  });

  it("exports an event map covering every SDK event OpenClaw cares about", () => {
    // Regression guard: ensure we don't accidentally drop a mapping when
    // refactoring. Every SDK event listed here must stay mappable from
    // some OpenClaw-side name.
    const sdkEventsCovered = new Set(Object.values(OPENCLAW_TO_SDK_EVENT));
    expect(sdkEventsCovered.has("PreToolUse")).toBe(true);
    expect(sdkEventsCovered.has("PostToolUse")).toBe(true);
    expect(sdkEventsCovered.has("SessionStart")).toBe(true);
    expect(sdkEventsCovered.has("SessionEnd")).toBe(true);
    expect(sdkEventsCovered.has("UserPromptSubmit")).toBe(true);
  });
});
