import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { describe, expect, it } from "vitest";
import {
  resolveThreadBindingPersona,
  resolveThreadBindingPersonaFromRecord,
} from "./thread-bindings.persona.js";
import type { ThreadBindingRecord } from "./thread-bindings.types.js";

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

  it("prefers cfg.agents.<id>.identity over binding label", () => {
    // F5b (Phase 10 Discord Surface Overhaul): when cfg provides identity for
    // the backend agent id, the persona should follow it — this keeps the
    // webhook username consistent across intro banner, reply-delivery, and
    // outbound-adapter instead of regressing to the raw binding label.
    const cfg = {
      agents: {
        list: [
          {
            id: "codex",
            identity: { name: "codex", emoji: "⚙" },
          },
        ],
      },
    } as unknown as OpenClawConfig;
    expect(
      resolveThreadBindingPersona({
        label: "discord-smoke-codex-phase123-20260416",
        agentId: "codex",
        cfg,
      }),
    ).toBe("⚙ codex");
  });
});
