import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { AssistantMessage, ToolResultMessage, UserMessage } from "@mariozechner/pi-ai";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeAgentAssistantMessage } from "../test-helpers/agent-message-fixtures.js";
import {
  ASSISTANT_AUDIO_RECOVERY_MARKER,
  sessionLikelyHasAssistantAudioPayloads,
  stripAssistantAudioPayloadsFromMessage,
  stripAssistantAudioPayloadsInMessages,
  stripAssistantAudioPayloadsInSession,
} from "./assistant-audio-recovery.js";

let tmpDir: string | undefined;
let testTimestamp = 1;
const nextTimestamp = () => testTimestamp++;

async function createTmpDir(): Promise<string> {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "assistant-audio-recovery-test-"));
  return tmpDir;
}

beforeEach(() => {
  testTimestamp = 1;
});

afterEach(async () => {
  if (tmpDir) {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    tmpDir = undefined;
  }
});

function makeUserMessage(text: string): UserMessage {
  return {
    role: "user",
    content: text,
    timestamp: nextTimestamp(),
  };
}

function makeTextAssistant(text: string): AssistantMessage {
  return makeAgentAssistantMessage({
    content: [{ type: "text", text }],
    model: "gpt-5.4",
    stopReason: "stop",
    timestamp: nextTimestamp(),
  });
}

function makeAudioReplyAssistant(opts: {
  base64Bytes?: number;
  preText?: string;
  mediaType?: string;
}): AssistantMessage {
  const base64Bytes = opts.base64Bytes ?? 4096;
  const data = "A".repeat(base64Bytes);
  const audioPart = {
    type: "audio" as const,
    source: {
      type: "base64" as const,
      media_type: opts.mediaType ?? "audio/mp4",
      data,
    },
  };
  const content: AssistantMessage["content"] = opts.preText
    ? [
        { type: "text", text: opts.preText },
        audioPart as unknown as AssistantMessage["content"][number],
      ]
    : [audioPart as unknown as AssistantMessage["content"][number]];
  return makeAgentAssistantMessage({
    content,
    model: "gpt-5.4",
    stopReason: "stop",
    timestamp: nextTimestamp(),
  });
}

function makeToolResult(text: string, toolCallId = "call_1"): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId,
    toolName: "read",
    content: [{ type: "text", text }],
    isError: false,
    timestamp: nextTimestamp(),
  };
}

describe("stripAssistantAudioPayloadsFromMessage", () => {
  it("replaces a standalone base64 audio part with the marker", () => {
    const msg = makeAudioReplyAssistant({ base64Bytes: 10_000 });
    const out = stripAssistantAudioPayloadsFromMessage(msg);
    expect(out).not.toBe(msg);
    expect(out.content).toHaveLength(1);
    const part = out.content[0] as { type: string; text: string };
    expect(part.type).toBe("text");
    expect(part.text).toBe(ASSISTANT_AUDIO_RECOVERY_MARKER);
  });

  it("preserves sibling text and only removes the audio part", () => {
    const msg = makeAudioReplyAssistant({ base64Bytes: 8_000, preText: "Audio reply" });
    const out = stripAssistantAudioPayloadsFromMessage(msg);
    expect(out.content).toHaveLength(2);
    expect(out.content[0]).toEqual({ type: "text", text: "Audio reply" });
    expect(out.content[1]).toEqual({
      type: "text",
      text: ASSISTANT_AUDIO_RECOVERY_MARKER,
    });
  });

  it("is idempotent: running twice does not alter the marker", () => {
    const msg = makeAudioReplyAssistant({ base64Bytes: 5_000, preText: "Audio reply" });
    const first = stripAssistantAudioPayloadsFromMessage(msg);
    const second = stripAssistantAudioPayloadsFromMessage(first);
    expect(second).toBe(first);
  });

  it("leaves text-only assistant messages untouched (reference equality)", () => {
    const msg = makeTextAssistant("hello world");
    const out = stripAssistantAudioPayloadsFromMessage(msg);
    expect(out).toBe(msg);
  });

  it("does not touch audio parts without a base64 source", () => {
    const msg = makeAgentAssistantMessage({
      content: [
        {
          type: "audio",
          source: { type: "url", url: "https://example.invalid/a.mp4" },
        } as unknown as AssistantMessage["content"][number],
      ],
      model: "gpt-5.4",
      stopReason: "stop",
      timestamp: nextTimestamp(),
    });
    const out = stripAssistantAudioPayloadsFromMessage(msg);
    expect(out).toBe(msg);
  });
});

describe("stripAssistantAudioPayloadsInMessages", () => {
  it("strips assistant audio while preserving other message types", () => {
    const messages: AgentMessage[] = [
      makeUserMessage("ping"),
      makeTextAssistant("pong"),
      makeToolResult("tool result body"),
      makeAudioReplyAssistant({ base64Bytes: 6_000, preText: "Audio reply" }),
    ];
    const { messages: out, strippedCount } = stripAssistantAudioPayloadsInMessages(messages);
    expect(strippedCount).toBe(1);
    expect(out[0]).toBe(messages[0]);
    expect(out[1]).toBe(messages[1]);
    expect(out[2]).toBe(messages[2]);
    expect(out[3]).not.toBe(messages[3]);
    const strippedAssistant = out[3] as AssistantMessage;
    expect(strippedAssistant.content).toHaveLength(2);
    expect((strippedAssistant.content[1] as { text: string }).text).toBe(
      ASSISTANT_AUDIO_RECOVERY_MARKER,
    );
  });

  it("returns strippedCount 0 when nothing to strip", () => {
    const messages: AgentMessage[] = [
      makeUserMessage("ping"),
      makeTextAssistant("pong"),
      makeToolResult("tool result"),
    ];
    const { strippedCount } = stripAssistantAudioPayloadsInMessages(messages);
    expect(strippedCount).toBe(0);
  });
});

describe("sessionLikelyHasAssistantAudioPayloads", () => {
  it("returns true when at least one assistant base64 audio payload is present", () => {
    const messages: AgentMessage[] = [
      makeUserMessage("hi"),
      makeTextAssistant("hi back"),
      makeAudioReplyAssistant({ base64Bytes: 2_000 }),
    ];
    expect(sessionLikelyHasAssistantAudioPayloads(messages)).toBe(true);
  });

  it("returns false for a purely text / toolResult transcript", () => {
    const messages: AgentMessage[] = [
      makeUserMessage("hi"),
      makeTextAssistant("hi back"),
      makeToolResult("result"),
    ];
    expect(sessionLikelyHasAssistantAudioPayloads(messages)).toBe(false);
  });
});

describe("stripAssistantAudioPayloadsInSession", () => {
  it("rewrites a session file to replace assistant audio payloads with the marker", async () => {
    const dir = await createTmpDir();
    const sm = SessionManager.create(dir, dir);
    sm.appendMessage(makeUserMessage("ping"));
    sm.appendMessage(makeTextAssistant("first reply"));
    sm.appendMessage(makeAudioReplyAssistant({ base64Bytes: 50_000, preText: "Audio reply" }));
    sm.appendMessage(makeUserMessage("ping again"));
    sm.appendMessage(makeAudioReplyAssistant({ base64Bytes: 120_000, preText: "Audio reply" }));
    const sessionFile = sm.getSessionFile()!;

    const branchCharsOf = (
      entries: ReturnType<ReturnType<typeof SessionManager.open>["getBranch"]>,
    ) =>
      entries.reduce((sum, entry) => {
        if (entry.type !== "message") {
          return sum;
        }
        return sum + JSON.stringify(entry.message).length;
      }, 0);

    const beforeBranchChars = branchCharsOf(SessionManager.open(sessionFile).getBranch());

    const result = await stripAssistantAudioPayloadsInSession({
      sessionFile,
      sessionKey: "agent:test:strip",
    });

    expect(result.stripped).toBe(true);
    expect(result.strippedCount).toBe(2);

    // The session-storage rewrite mechanism branches and re-appends the
    // suffix, so the raw file may grow even when the active branch shrinks.
    // The correctness signal is the size of the *active* branch, not the
    // raw jsonl byte length.
    const after = SessionManager.open(sessionFile).getBranch();
    const afterBranchChars = branchCharsOf(after);
    expect(afterBranchChars).toBeLessThan(beforeBranchChars);
    expect(beforeBranchChars - afterBranchChars).toBeGreaterThan(50_000 + 120_000 - 1_000);

    const assistantEntries = after.filter(
      (entry): entry is typeof entry & { type: "message" } =>
        entry.type === "message" && (entry.message as { role?: string }).role === "assistant",
    );
    const audioStillPresent = assistantEntries.some((entry) => {
      const content = (entry.message as AssistantMessage).content;
      return (
        Array.isArray(content) &&
        content.some((part) => (part as { type: string }).type === "audio")
      );
    });
    expect(audioStillPresent).toBe(false);

    const markerPresent = assistantEntries.some((entry) => {
      const content = (entry.message as AssistantMessage).content;
      return (
        Array.isArray(content) &&
        content.some(
          (part) =>
            (part as { type: string }).type === "text" &&
            (part as { text?: string }).text === ASSISTANT_AUDIO_RECOVERY_MARKER,
        )
      );
    });
    expect(markerPresent).toBe(true);
  });

  it("is a no-op on sessions without assistant audio (negative path)", async () => {
    const dir = await createTmpDir();
    const sm = SessionManager.create(dir, dir);
    sm.appendMessage(makeUserMessage("ping"));
    sm.appendMessage(makeTextAssistant("pong"));
    sm.appendMessage(makeToolResult("x".repeat(500)));
    const sessionFile = sm.getSessionFile()!;
    const beforeBytes = (await fs.stat(sessionFile)).size;

    const result = await stripAssistantAudioPayloadsInSession({
      sessionFile,
      sessionKey: "agent:test:noop",
    });

    expect(result.stripped).toBe(false);
    expect(result.strippedCount).toBe(0);
    expect(result.reason).toBe("no assistant audio payloads");

    const afterBytes = (await fs.stat(sessionFile)).size;
    expect(afterBytes).toBe(beforeBytes);

    const after = SessionManager.open(sessionFile).getBranch();
    const toolResults = after.filter(
      (entry) =>
        entry.type === "message" && (entry.message as { role?: string }).role === "toolResult",
    );
    expect(toolResults).toHaveLength(1);
  });

  it("is idempotent on an already-stripped session", async () => {
    const dir = await createTmpDir();
    const sm = SessionManager.create(dir, dir);
    sm.appendMessage(makeUserMessage("ping"));
    sm.appendMessage(makeAudioReplyAssistant({ base64Bytes: 20_000, preText: "Audio reply" }));
    const sessionFile = sm.getSessionFile()!;

    const first = await stripAssistantAudioPayloadsInSession({ sessionFile });
    expect(first.stripped).toBe(true);
    expect(first.strippedCount).toBe(1);

    const beforeSecond = (await fs.stat(sessionFile)).size;
    const second = await stripAssistantAudioPayloadsInSession({ sessionFile });
    expect(second.stripped).toBe(false);
    expect(second.strippedCount).toBe(0);
    expect(second.reason).toBe("no assistant audio payloads");
    const afterSecond = (await fs.stat(sessionFile)).size;
    expect(afterSecond).toBe(beforeSecond);
  });

  it("preserves an immediately-preceding tool-result message (negative cross-type guard)", async () => {
    const dir = await createTmpDir();
    const sm = SessionManager.create(dir, dir);
    sm.appendMessage(makeUserMessage("ping"));
    const toolBody = "tool_result_preserved_body " + "x".repeat(200);
    sm.appendMessage(makeToolResult(toolBody, "call_keep"));
    sm.appendMessage(makeAudioReplyAssistant({ base64Bytes: 10_000, preText: "Audio reply" }));
    const sessionFile = sm.getSessionFile()!;

    const result = await stripAssistantAudioPayloadsInSession({ sessionFile });
    expect(result.stripped).toBe(true);
    expect(result.strippedCount).toBe(1);

    const after = SessionManager.open(sessionFile).getBranch();
    const toolEntry = after.find(
      (entry) =>
        entry.type === "message" && (entry.message as { role?: string }).role === "toolResult",
    );
    expect(toolEntry).toBeDefined();
    if (toolEntry && toolEntry.type === "message") {
      const content = (toolEntry.message as ToolResultMessage).content;
      const textBlock = Array.isArray(content) ? (content[0] as { text?: string }) : undefined;
      expect(textBlock?.text).toBe(toolBody);
    }
  });
});
