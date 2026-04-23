// Production-derived fixture for PR #69486.
// Source stem: <openclaw-agent-sessions>/main/sessions/f65ebb43-8526-40ee-856f-4706a3f353d4
// Redaction: all user text, tool outputs, compaction summaries, provider/model ids,
// cwd, thinkingSignatures, encrypted_content — replaced with placeholders.
// Opaque real IDs pseudonymized for readability. Lineage shape preserved 1:1.

type RawEntry = Record<string, unknown>;

export const repro69486LineageFromProduction: RawEntry[] = [
  {
    type: "session",
    version: 3,
    id: "session-root",
    timestamp: "2026-04-18T02:00:00.000Z",
    cwd: "REDACTED_WORKDIR",
  },
  {
    type: "model_change",
    id: "model-change-1",
    parentId: null,
    timestamp: "2026-04-18T02:00:00.001Z",
    provider: "REDACTED",
    modelId: "REDACTED",
  },
  {
    type: "thinking_level_change",
    id: "thinking-change-1",
    parentId: "model-change-1",
    timestamp: "2026-04-18T02:00:00.002Z",
    thinkingLevel: "high",
  },
  {
    type: "message",
    id: "msg-user-1",
    parentId: "session-root",
    timestamp: "2026-04-18T02:00:30.000Z",
    message: {
      role: "user",
      content: [{ type: "text", text: "[redacted user prompt]" }],
    },
  },
  {
    type: "message",
    id: "msg-assistant-parent",
    parentId: "msg-user-1",
    timestamp: "2026-04-18T02:01:03.038Z",
    message: {
      role: "assistant",
      content: [{ type: "toolCall", id: "call_1", name: "read", arguments: {} }],
    },
  },
  {
    type: "message",
    id: "msg-toolresult-1a",
    parentId: "msg-assistant-parent",
    timestamp: "2026-04-18T02:01:07.363Z",
    message: {
      role: "toolResult",
      content: [
        {
          type: "toolResult",
          toolCallId: "call_1",
          content: [{ type: "text", text: "[redacted tool output A]" }],
        },
      ],
    },
  },
  {
    type: "compaction",
    id: "compaction-1",
    parentId: "msg-toolresult-1a",
    timestamp: "2026-04-18T05:30:23.965Z",
    summary: "[redacted compaction summary]",
  },
  {
    type: "compaction",
    id: "compaction-2",
    parentId: "compaction-1",
    timestamp: "2026-04-18T05:33:07.098Z",
    summary: "[redacted compaction summary]",
  },
  {
    type: "compaction",
    id: "compaction-3",
    parentId: "compaction-2",
    timestamp: "2026-04-18T05:33:09.196Z",
    summary: "[redacted compaction summary]",
  },
  {
    type: "compaction",
    id: "compaction-4",
    parentId: "compaction-3",
    timestamp: "2026-04-18T05:33:11.279Z",
    summary: "[redacted compaction summary]",
  },
  {
    type: "message",
    id: "msg-toolresult-1b",
    parentId: "msg-assistant-parent",
    timestamp: "2026-04-18T05:33:12.173Z",
    message: {
      role: "toolResult",
      content: [
        {
          type: "toolResult",
          toolCallId: "call_1",
          content: [{ type: "text", text: "[redacted tool output B]" }],
        },
      ],
    },
  },
  {
    type: "compaction",
    id: "compaction-burst-1",
    parentId: "msg-toolresult-1b",
    timestamp: "2026-04-18T05:33:12.185Z",
    summary: "[redacted]",
  },
  {
    type: "compaction",
    id: "compaction-burst-2",
    parentId: "compaction-burst-1",
    timestamp: "2026-04-18T05:33:12.196Z",
    summary: "[redacted]",
  },
  {
    type: "compaction",
    id: "compaction-burst-3",
    parentId: "compaction-burst-2",
    timestamp: "2026-04-18T05:33:12.208Z",
    summary: "[redacted]",
  },
];
