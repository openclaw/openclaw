import type { AgentMessage } from "openclaw/plugin-sdk/agent-harness-runtime";
import { SessionManager } from "openclaw/plugin-sdk/agent-sessions";
import { expect, it } from "vitest";
import { buildCodexSelectedHistoryItems } from "./context-engine-history-items.js";
import { projectContextEngineAssemblyForCodex } from "./context-engine-projection.js";
import { setupSessionHistoryFixtures, settledFixture } from "./session-history.test-support.js";
import {
  captureCodexSettledTurnFinalizationContext,
  CodexSettledTurnContext,
} from "./settled-turn-context.js";
import { assistantMessage } from "./test-support.js";
import { projectBoundedCodexVisibleSessionHistory } from "./transcript-history-projection.js";

const { writeSession, writeSqliteSession } = setupSessionHistoryFixtures();

function recoveryNoticeHistory() {
  const text = "Restart recovery stopped. Resume in WebChat.";
  const saved = "Unconfirmed draft must stay out of model context.";
  const local = {
    ...assistantMessage(text, 1),
    provider: "openclaw",
    model: "delivery-mirror",
    content: [
      { type: "text" as const, text },
      { type: "text" as const, text: `\nSaved reply (delivery unconfirmed):\n${saved}` },
    ],
  };
  const confirmed = {
    ...assistantMessage(text, 2),
    provider: "openclaw",
    model: "automation-result",
    display: false,
    openclawAutomation: {
      kind: "recovery-notice",
      noticeId: "notice",
      localNotice: { entryId: "private-anchor" },
    },
  };
  const messages: AgentMessage[] = [local, confirmed];
  return { text, saved, messages };
}

it.each(["file", "sqlite"] as const)(
  "replays a hidden confirmed notice without its local saved reply from %s",
  async (storage) => {
    const { text, saved, messages: prior } = recoveryNoticeHistory();
    const { settledMessages } = settledFixture();
    const messages = [...prior, ...settledMessages];
    const sqlite = storage === "sqlite" ? await writeSqliteSession() : undefined;
    if (sqlite) {
      for (const message of messages) {
        await sqlite.append(message);
      }
    }
    const target = sqlite?.target ?? {
      sessionFile: await writeSession(
        messages.map((message, index) => ({
          type: "message",
          message,
          id: `entry-${index}`,
          parentId: index ? `entry-${index - 1}` : null,
          timestamp: "2026-06-15T00:00:00.000Z",
        })),
      ),
      sessionId: "codex-session",
      sessionKey: "codex-session",
    };
    const captured = await captureCodexSettledTurnFinalizationContext({
      ...target,
      model: "gpt-5.6-luna",
      settledMessages,
      mirroredMessages: settledMessages,
      turnId: "settled",
    });
    expect(captured).toBeInstanceOf(CodexSettledTurnContext);
    const data = JSON.stringify(captured?.data);
    expect(data.split(text)).toHaveLength(2);
    expect(data).not.toContain(saved);
    expect(data).not.toContain("private-anchor");
    expect(data).not.toContain("localNotice");
  },
);

it.each(["legacy", "selected", "import"] as const)(
  "projects only the confirmed notice and normal assistant history through %s",
  async (projection) => {
    const { text, saved, messages } = recoveryNoticeHistory();
    messages.push(assistantMessage("Ordinary assistant reply.", 3));
    const projected =
      projection === "legacy"
        ? await projectContextEngineAssemblyForCodex({
            assembledMessages: messages,
            prompt: "Next",
          })
        : projection === "selected"
          ? await buildCodexSelectedHistoryItems({ messages, tokenBudget: 1_000 })
          : projectBoundedCodexVisibleSessionHistory(
              messages.map((message, index) => ({
                entryId: `entry-${index}`,
                parentId: index ? `entry-${index - 1}` : null,
                seq: index,
                role: message.role,
                message,
              })),
            );
    const data = JSON.stringify(projected);
    expect(data.split(text)).toHaveLength(2);
    expect(data).toContain("Ordinary assistant reply.");
    expect(data).not.toContain(saved);
    expect(data).not.toContain("private-anchor");
    expect(data).not.toContain("localNotice");
  },
);

type CustomMessage = Extract<AgentMessage, { role: "custom" }>;
function custom(
  customType: string,
  content: CustomMessage["content"],
  timestamp: number,
  options: Partial<CustomMessage> = {},
): CustomMessage {
  return { role: "custom", customType, content, timestamp, display: false, ...options };
}

it.each(["file", "sqlite"] as const)(
  "captures settled evidence after durable control history from %s",
  async (storage) => {
    const yieldText = "Continue after the worker finishes.";
    const prior: AgentMessage[] = [
      custom("plugin.durable-note", [{ type: "text", text: "Keep the agreed task scope." }], 1),
      {
        role: "bashExecution",
        command: "check",
        output: "Earlier check failed.",
        exitCode: 2,
        cancelled: false,
        truncated: false,
        timestamp: 2,
      },
      { role: "branchSummary", summary: "Prior branch decision.", fromId: "branch", timestamp: 3 },
      {
        role: "compactionSummary",
        summary: "Prior task context.",
        tokensBefore: 100,
        timestamp: 4,
      },
      custom("openclaw.context-compaction", "excluded compaction notice", 5, {
        display: true,
        excludeFromContext: true,
      }),
      custom("openclaw.runtime-context", "obsolete runtime instructions", 6),
    ];
    const { upstreamPrompt, settledMessages } = settledFixture();
    const records = [
      {
        type: "custom_message",
        customType: "openclaw.sessions_yield",
        content: yieldText,
        display: false,
        details: { source: "sessions_yield", message: yieldText },
      },
      ...[...prior, ...settledMessages].map((message) => ({ type: "message", message })),
    ].map((entry, index) =>
      Object.assign(entry, {
        id: `entry-${index}`,
        parentId: index ? `entry-${index - 1}` : null,
        timestamp: "2026-06-15T00:00:00.000Z",
      }),
    );
    const fixture = storage === "sqlite" ? await writeSqliteSession() : undefined;
    if (fixture) {
      const source = SessionManager.open(fixture.sessionTarget);
      source.appendCustomMessageEntry("openclaw.sessions_yield", yieldText, false, {
        source: "sessions_yield",
        message: yieldText,
      });
      for (const message of [...prior, ...settledMessages]) {
        await fixture.append(message);
      }
    }
    const target = fixture
      ? fixture.target
      : {
          sessionFile: await writeSession(records),
          sessionId: "codex-session",
          sessionKey: "codex-session",
        };
    const captured = await captureCodexSettledTurnFinalizationContext({
      ...target,
      model: "gpt-5.6-luna",
      settledMessages,
      mirroredMessages: settledMessages,
      turnId: "settled",
    });
    expect(captured).toBeInstanceOf(CodexSettledTurnContext);
    const expectedHistory = [
      yieldText,
      "Keep the agreed task scope.",
      "Ran `check`\n```\nEarlier check failed.\n```\n\nCommand exited with code 2",
      "The following is a summary of a branch that this conversation came back from:\n\n<summary>\nPrior branch decision.</summary>",
      "The conversation history before this point was compacted into the following summary:\n\n<summary>\nPrior task context.\n</summary>",
    ].map((text) => ({
      type: "message",
      role: "user",
      content: [{ type: "input_text", text }],
    }));
    expect(captured?.data).toEqual(expect.arrayContaining(expectedHistory));
    expect(captured?.data.slice(-3)).toEqual([
      { type: "message", role: "user", content: [{ type: "input_text", text: upstreamPrompt }] },
      { type: "function_call", call_id: "sent", name: "message", arguments: "{}" },
      { type: "function_call_output", call_id: "sent", output: "Synthetic update sent." },
    ]);
    expect(JSON.stringify(captured?.data)).not.toMatch(
      /excluded compaction notice|obsolete runtime instructions/u,
    );
  },
);
