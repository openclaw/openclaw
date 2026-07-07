// Discord tests cover thread bindings.persona plugin behavior.
import { describe, expect, it } from "vitest";
import {
  resolveThreadBindingPersona,
  resolveThreadBindingPersonaFromRecord,
} from "./thread-bindings.persona.js";
import type { ThreadBindingRecord } from "./thread-bindings.types.js";

function hasLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        return true;
      }
      index += 1;
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

describe("thread binding persona", () => {
  it("prefers explicit label and prefixes with gear", () => {
    expect(resolveThreadBindingPersona({ label: "codex thread", agentId: "codex" })).toBe(
      "⚙️ codex thread",
    );
  });

  it("falls back to agent id when label is missing", () => {
    expect(resolveThreadBindingPersona({ agentId: "codex" })).toBe("⚙️ codex");
  });

  it("builds persona from binding record", () => {
    const record = {
      accountId: "default",
      channelId: "parent-1",
      threadId: "thread-1",
      targetKind: "acp",
      targetSessionKey: "agent:codex:acp:session-1",
      agentId: "codex",
      boundBy: "system",
      boundAt: Date.now(),
      lastActivityAt: Date.now(),
      label: "codex-thread",
    } satisfies ThreadBindingRecord;
    expect(resolveThreadBindingPersonaFromRecord(record)).toBe("⚙️ codex-thread");
  });
  it("keeps thread binding webhook personas on a UTF-16 boundary", () => {
    const record = {
      accountId: "default",
      channelId: "parent-1",
      threadId: "thread-1",
      targetKind: "acp",
      targetSessionKey: "agent:codex:acp:session-1",
      agentId: "codex",
      boundBy: "system",
      boundAt: Date.now(),
      lastActivityAt: Date.now(),
      label: `${"a".repeat(77)}\u{1f63e}tail`,
    } satisfies ThreadBindingRecord;

    const persona = resolveThreadBindingPersonaFromRecord(record);

    expect(persona.length).toBeLessThanOrEqual(80);
    expect(hasLoneSurrogate(persona)).toBe(false);
  });
});
