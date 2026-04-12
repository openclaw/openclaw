import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFeishuMessagesFromTranscript } from "./transcript-reader.js";

const resolveStorePathMock = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/session-store-runtime", () => ({
  resolveStorePath: resolveStorePathMock,
}));

function defaultStorePath(store: unknown, opts: { agentId?: string }) {
  return `/tmp/test-sessions/agents/${opts?.agentId ?? "default"}/sessions/sessions.json`;
}

function buildTranscriptLine(params: {
  role: string;
  text: string;
  channel?: string;
  chatId?: string;
  chatType?: "direct" | "group";
  providerMessageId?: string;
  providerMessageIds?: string[];
  timestamp?: number;
  threadId?: string;
}): string {
  const hasMeta =
    params.channel || params.chatId || params.providerMessageId || params.providerMessageIds;
  const meta = hasMeta
    ? {
        openclawMessageMeta: {
          ...(params.channel ? { channel: params.channel } : {}),
          ...(params.chatId ? { chatId: params.chatId } : {}),
          ...(params.chatType ? { chatType: params.chatType } : {}),
          ...(params.providerMessageId ? { providerMessageId: params.providerMessageId } : {}),
          ...(params.providerMessageIds ? { providerMessageIds: params.providerMessageIds } : {}),
          ...(params.threadId ? { threadId: params.threadId } : {}),
        },
      }
    : {};
  return JSON.stringify({
    id: `msg_${Math.random().toString(36).slice(2, 8)}`,
    message: {
      role: params.role,
      content: [{ type: "text", text: params.text }],
      ...(params.timestamp ? { timestamp: params.timestamp } : {}),
      ...meta,
    },
  });
}

describe("readFeishuMessagesFromTranscript", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    resolveStorePathMock.mockReset();
  });

  function setupMock() {
    resolveStorePathMock.mockImplementation(defaultStorePath);
  }

  it("returns empty array when transcript file does not exist", () => {
    setupMock();
    vi.spyOn(fs, "existsSync").mockReturnValue(false);
    const result = readFeishuMessagesFromTranscript({
      sessionId: "sess_1",
      agentId: "agent_1",
      chatId: "oc_group_1",
    });
    expect(result).toEqual([]);
  });

  it("filters messages by chatId and returns chronological order", () => {
    setupMock();
    const transcript = [
      JSON.stringify({ type: "session", id: "sess_1" }),
      buildTranscriptLine({
        role: "user",
        text: "msg in group 1",
        channel: "feishu",
        chatId: "oc_group_1",
        providerMessageId: "om_1",
        timestamp: 1000,
      }),
      buildTranscriptLine({ role: "assistant", text: "bot reply" }),
      buildTranscriptLine({
        role: "user",
        text: "msg in group 2",
        channel: "feishu",
        chatId: "oc_group_2",
        providerMessageId: "om_2",
        timestamp: 2000,
      }),
      buildTranscriptLine({
        role: "user",
        text: "msg2 in group 1",
        channel: "feishu",
        chatId: "oc_group_1",
        providerMessageId: "om_3",
        timestamp: 3000,
      }),
    ].join("\n");

    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    vi.spyOn(fs, "readFileSync").mockReturnValue(transcript);

    const result = readFeishuMessagesFromTranscript({
      sessionId: "sess_1",
      agentId: "agent_1",
      chatId: "oc_group_1",
    });

    expect(result).toHaveLength(2);
    // Newest-first
    expect(result[0].messageId).toBe("om_3");
    expect(result[0].content).toBe("msg2 in group 1");
    expect(result[1].messageId).toBe("om_1");
    expect(result[1].content).toBe("msg in group 1");
  });

  it("finds a single message by providerMessageId", () => {
    setupMock();
    const transcript = [
      JSON.stringify({ type: "session", id: "sess_1" }),
      buildTranscriptLine({
        role: "user",
        text: "target msg",
        channel: "feishu",
        chatId: "oc_1",
        providerMessageId: "om_target",
        timestamp: 1000,
      }),
      buildTranscriptLine({
        role: "user",
        text: "other msg",
        channel: "feishu",
        chatId: "oc_1",
        providerMessageId: "om_other",
        timestamp: 2000,
      }),
    ].join("\n");

    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    vi.spyOn(fs, "readFileSync").mockReturnValue(transcript);

    const result = readFeishuMessagesFromTranscript({
      sessionId: "sess_1",
      agentId: "agent_1",
      messageId: "om_target",
    });

    expect(result).toHaveLength(1);
    expect(result[0].messageId).toBe("om_target");
    expect(result[0].content).toBe("target msg");
  });

  it("returns empty when messageId not found", () => {
    setupMock();
    const transcript = [
      JSON.stringify({ type: "session", id: "sess_1" }),
      buildTranscriptLine({
        role: "user",
        text: "some msg",
        channel: "feishu",
        chatId: "oc_1",
        providerMessageId: "om_1",
      }),
    ].join("\n");

    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    vi.spyOn(fs, "readFileSync").mockReturnValue(transcript);

    const result = readFeishuMessagesFromTranscript({
      sessionId: "sess_1",
      messageId: "om_nonexistent",
    });

    expect(result).toEqual([]);
  });

  it("respects limit parameter", () => {
    setupMock();
    const lines = [JSON.stringify({ type: "session", id: "sess_1" })];
    for (let i = 0; i < 10; i++) {
      lines.push(
        buildTranscriptLine({
          role: "user",
          text: `msg ${i}`,
          channel: "feishu",
          chatId: "oc_1",
          providerMessageId: `om_${i}`,
          timestamp: i * 1000,
        }),
      );
    }

    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    vi.spyOn(fs, "readFileSync").mockReturnValue(lines.join("\n"));

    const result = readFeishuMessagesFromTranscript({
      sessionId: "sess_1",
      chatId: "oc_1",
      limit: 3,
    });

    expect(result).toHaveLength(3);
    // Should return the LAST 3 messages, newest-first
    expect(result[0].messageId).toBe("om_9");
    expect(result[2].messageId).toBe("om_7");
  });

  it("ignores non-feishu messages but includes feishu assistant delivery mirrors", () => {
    setupMock();
    const transcript = [
      JSON.stringify({ type: "session", id: "sess_1" }),
      buildTranscriptLine({
        role: "user",
        text: "discord msg",
        channel: "discord",
        chatId: "ch_1",
        providerMessageId: "d_1",
      }),
      buildTranscriptLine({ role: "assistant", text: "bot reply without meta" }),
      buildTranscriptLine({
        role: "user",
        text: "feishu msg",
        channel: "feishu",
        chatId: "oc_1",
        providerMessageId: "om_1",
        timestamp: 1000,
      }),
      buildTranscriptLine({
        role: "assistant",
        text: "bot feishu reply",
        channel: "feishu",
        chatId: "oc_1",
        chatType: "group",
        providerMessageId: "om_reply_1",
        timestamp: 2000,
      }),
    ].join("\n");

    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    vi.spyOn(fs, "readFileSync").mockReturnValue(transcript);

    const result = readFeishuMessagesFromTranscript({
      sessionId: "sess_1",
      chatId: "oc_1",
    });

    expect(result).toHaveLength(2);
    // Newest-first: delivery mirror (timestamp 2000) before user msg (timestamp 1000)
    expect(result[0]).toMatchObject({ messageId: "om_reply_1", senderType: "app" });
    expect(result[1]).toMatchObject({ messageId: "om_1", senderType: undefined });
  });

  it("finds delivery-mirror message by providerMessageIds array", () => {
    setupMock();
    const transcript = [
      JSON.stringify({ type: "session", id: "sess_1" }),
      buildTranscriptLine({
        role: "assistant",
        text: "chunked reply",
        channel: "feishu",
        chatId: "oc_1",
        providerMessageIds: ["om_chunk_1", "om_chunk_2"],
        timestamp: 1000,
      }),
    ].join("\n");

    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    vi.spyOn(fs, "readFileSync").mockReturnValue(transcript);

    // Look up by one of the chunk IDs
    const result = readFeishuMessagesFromTranscript({
      sessionId: "sess_1",
      messageId: "om_chunk_1",
    });

    expect(result).toHaveLength(1);
    expect(result[0].messageId).toBe("om_chunk_2"); // last in providerMessageIds
    expect(result[0].senderType).toBe("app");
  });

  it("forwards store param to resolveStorePath", () => {
    resolveStorePathMock.mockReturnValue("/custom/store/sessions.json");
    vi.spyOn(fs, "existsSync").mockReturnValue(false);

    readFeishuMessagesFromTranscript({
      sessionId: "sess_1",
      agentId: "agent_1",
      store: "/custom/store/sessions.json",
      chatId: "oc_1",
    });

    expect(resolveStorePathMock).toHaveBeenCalledWith("/custom/store/sessions.json", {
      agentId: "agent_1",
    });
  });
});
