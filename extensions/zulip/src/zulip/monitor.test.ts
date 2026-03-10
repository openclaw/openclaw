import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { finalizeInboundContext } from "../../../../src/auto-reply/reply/inbound-context.js";
import { fetchZulipMessages, type ZulipClient, type ZulipMessage } from "./client.js";
import {
  buildZulipAgentBody,
  formatZulipTopicHistoryBody,
  processZulipUploads,
  resolveZulipComponentReplyTarget,
  resolveZulipTopicContext,
} from "./monitor.js";

vi.mock("./client.js", async () => {
  const actual = await vi.importActual<typeof import("./client.js")>("./client.js");
  return {
    ...actual,
    fetchZulipMessages: vi.fn(),
  };
});

const mockedFetchZulipMessages = vi.mocked(fetchZulipMessages);

const DUMMY_CLIENT: ZulipClient = {
  baseUrl: "https://zulip.example.com",
  botEmail: "bot@zulip.example.com",
  botApiKey: "key",
  authHeader: "Basic abc",
  request: vi.fn(),
  requestForm: vi.fn(),
};

function createStreamMessage(params: {
  id: number;
  senderId: number;
  senderName: string;
  senderEmail?: string;
  content: string;
  timestamp: number;
}): ZulipMessage {
  return {
    id: params.id,
    sender_id: params.senderId,
    sender_email: params.senderEmail ?? `${params.senderName.toLowerCase()}@example.com`,
    sender_full_name: params.senderName,
    type: "stream",
    stream_id: 42,
    display_recipient: "engineering",
    subject: "topic",
    content: params.content,
    timestamp: params.timestamp,
  };
}

describe("formatZulipTopicHistoryBody", () => {
  it("formats user and bot messages with role labels and message ids", () => {
    const formatted = formatZulipTopicHistoryBody({
      messages: [
        createStreamMessage({
          id: 10,
          senderId: 101,
          senderName: "Alice",
          content: "Question",
          timestamp: 1_700_000_000,
        }),
        createStreamMessage({
          id: 11,
          senderId: 999,
          senderName: "Botty",
          content: "Answer",
          timestamp: 1_700_000_100,
        }),
      ],
      botUserId: 999,
      formatInboundEnvelope: (envelope) => `${envelope.from} :: ${envelope.body}`,
    });

    expect(formatted).toContain("Alice (user)");
    expect(formatted).toContain("Botty (assistant)");
    expect(formatted).toContain("[zulip message id: 10]");
    expect(formatted).toContain("[zulip message id: 11]");
  });
});

describe("buildZulipAgentBody", () => {
  it("keeps command text clean while giving the agent attachment-aware text", () => {
    const result = buildZulipAgentBody({
      cleanText:
        "what about this info? [inline file contents already included below: PastedText.txt]",
      strippedContent:
        "@**Cody** what about this info? [inline file contents already included below: PastedText.txt]",
      attachmentInfo:
        '\n[Attached files; inline text contents are already included here when available]\n📎 File "PastedText.txt" (contents already included below; do not use tools to open it unless a filesystem path is explicitly provided):\n```\nSecret phrase\n```',
      botMentionRegex: /@\*\*Cody\*\*/gi,
      messageId: 3538,
    });

    expect(result.cleanStripped).toBe(
      "what about this info? [inline file contents already included below: PastedText.txt]",
    );
    expect(result.textWithAttachments).toContain(
      "[Attached files; inline text contents are already included here when available]",
    );
    expect(result.bodyForAgent).toContain('📎 File "PastedText.txt"');
    expect(result.bodyForAgent).toContain("[zulip message id: 3538]");
    expect(result.bodyForAgent).not.toContain("@**Cody**");

    const finalized = finalizeInboundContext({
      Body: "Envelope body",
      BodyForAgent: result.bodyForAgent,
      RawBody: result.cleanStripped,
      CommandBody: result.cleanStripped,
      From: "zulip:stream:04💻 coding-loop:topic:test",
      To: "zulip:stream:04💻 coding-loop:topic:test",
      SessionKey: "agent:cody:zulip:test",
      ChatType: "group",
    });

    expect(finalized.BodyForAgent).toContain('📎 File "PastedText.txt"');
    expect(finalized.RawBody).toBe(
      "what about this info? [inline file contents already included below: PastedText.txt]",
    );
    expect(finalized.CommandBody).toBe(
      "what about this info? [inline file contents already included below: PastedText.txt]",
    );
    expect(finalized.BodyForCommands).toBe(
      "what about this info? [inline file contents already included below: PastedText.txt]",
    );
  });
});

describe("processZulipUploads", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("extracts non-text uploads into media paths and types", async () => {
    const mockedFetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(new Uint8Array([1, 2, 3, 4]), {
        status: 200,
        headers: {
          "content-type": "image/png",
          "content-length": "4",
        },
      }),
    );

    const saved = {
      path: "/tmp/media/meal.heic",
      contentType: "image/png",
    };
    const saveMedia = vi.fn(async () => saved);

    const result = await processZulipUploads(
      DUMMY_CLIENT,
      "Breakfast meal [BreakfastLiev](/user_uploads/image_DF2CE095-9465-477A-93E7-CDFAB799867D_1771258400.heic)",
      1024,
      saveMedia,
    );

    expect(result.mediaPaths).toEqual([saved.path]);
    expect(result.mediaTypes).toEqual([saved.contentType]);
    expect(result.strippedContent).toContain("[attached: BreakfastLiev]");
    expect(saveMedia).toHaveBeenCalledTimes(1);
    expect(mockedFetch).toHaveBeenCalledTimes(1);
    expect(result.attachmentInfo).toContain("prepared for model analysis");
    const saveArg = (
      saveMedia.mock.calls[0] as unknown as [
        { buffer: { length: number }; contentType: string; fileName: string },
      ]
    )[0];
    expect(saveArg.fileName).toBe("BreakfastLiev");
    expect(saveArg.contentType).toBe("image/png");
    expect(saveArg.buffer.length).toBe(4);
  });

  it("inlines readable text uploads without media paths", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("hello\nworld", {
        status: 200,
        headers: {
          "content-type": "text/plain",
          "content-length": "11",
        },
      }),
    );

    const saveMedia = vi.fn(async () => null);
    const result = await processZulipUploads(
      DUMMY_CLIENT,
      "Read this [notes.txt](/user_uploads/notes.txt)",
      1024,
      saveMedia,
    );

    expect(result.mediaPaths).toEqual([]);
    expect(result.mediaTypes).toEqual([]);
    expect(result.strippedContent).toContain(
      "[inline file contents already included below: notes.txt]",
    );
    expect(result.attachmentInfo).toContain(
      '📎 File "notes.txt" (contents already included below; do not use tools to open it unless a filesystem path is explicitly provided):\n```\nhello\nworld\n```',
    );
    expect(saveMedia).not.toHaveBeenCalled();
  });

  it("caches large text uploads for model analysis", async () => {
    const largeText = "A".repeat(120_000);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(largeText, {
        status: 200,
        headers: {
          "content-type": "text/plain",
          "content-length": String(largeText.length),
        },
      }),
    );

    const saved = {
      path: "/tmp/media/PastedText.txt",
      contentType: "text/plain",
    };
    const saveMedia = vi.fn(async () => saved);

    const result = await processZulipUploads(
      DUMMY_CLIENT,
      "Read this [PastedText.txt](/user_uploads/PastedText.txt)",
      200_000,
      saveMedia,
    );

    expect(result.mediaPaths).toEqual([saved.path]);
    expect(result.mediaTypes).toEqual([saved.contentType]);
    expect(result.strippedContent).toContain("[attached: PastedText.txt]");
    expect(result.attachmentInfo).toContain(
      "too large to inline; cached for model analysis at path: /tmp/media/PastedText.txt",
    );
    expect(saveMedia).toHaveBeenCalledTimes(1);
  });

  it("marks oversized uploads as skipped", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("oversized", {
        status: 200,
        headers: {
          "content-type": "application/octet-stream",
          "content-length": "20",
        },
      }),
    );

    const saveMedia = vi.fn(async () => null);
    const result = await processZulipUploads(
      DUMMY_CLIENT,
      "Image [oops](/user_uploads/too-large.bin)",
      10,
      saveMedia,
    );

    expect(result.mediaPaths).toEqual([]);
    expect(result.mediaTypes).toEqual([]);
    expect(result.attachmentInfo).toContain("skipped — exceeds 0 MB limit");
    expect(result.strippedContent).toContain("[attached: oops — too large to download]");
    expect(saveMedia).not.toHaveBeenCalled();
  });
});

describe("resolveZulipTopicContext", () => {
  beforeEach(() => {
    mockedFetchZulipMessages.mockReset();
  });

  it("fetches and formats topic history for first stream turn", async () => {
    mockedFetchZulipMessages.mockResolvedValueOnce([
      createStreamMessage({
        id: 15,
        senderId: 999,
        senderName: "Botty",
        content: "Bot response",
        timestamp: 1_700_000_150,
      }),
      createStreamMessage({
        id: 13,
        senderId: 101,
        senderName: "Alice",
        content: "Prior question",
        timestamp: 1_700_000_130,
      }),
      createStreamMessage({
        id: 16,
        senderId: 102,
        senderName: "Bob",
        content: "   ",
        timestamp: 1_700_000_160,
      }),
      createStreamMessage({
        id: 17,
        senderId: 101,
        senderName: "Alice",
        content: "Current message",
        timestamp: 1_700_000_170,
      }),
    ]);

    const result = await resolveZulipTopicContext({
      client: DUMMY_CLIENT,
      kind: "stream",
      streamName: "engineering",
      topic: "deploy",
      currentMessageId: 17,
      botUserId: 999,
      initialHistoryLimit: 2,
      sessionPreviousTimestamp: undefined,
      formatInboundEnvelope: (envelope) => `${envelope.from} :: ${envelope.body}`,
    });

    expect(result.threadLabel).toBe("Zulip topic #engineering > deploy");
    expect(result.isFirstTopicTurn).toBe(true);
    expect(result.threadHistoryBody).toBeDefined();
    expect(result.threadHistoryBody).toContain("Alice (user)");
    expect(result.threadHistoryBody).toContain("Botty (assistant)");
    expect(result.threadHistoryBody).toContain("[zulip message id: 13]");
    expect(result.threadHistoryBody).toContain("[zulip message id: 15]");
    expect(result.threadHistoryBody).not.toContain("Current message");

    expect(mockedFetchZulipMessages).toHaveBeenCalledTimes(1);
    expect(mockedFetchZulipMessages).toHaveBeenCalledWith(DUMMY_CLIENT, {
      anchor: "newest",
      numBefore: 3,
      numAfter: 0,
      narrow: [
        { operator: "stream", operand: "engineering" },
        { operator: "topic", operand: "deploy" },
      ],
    });
  });

  it("does not fetch for existing stream sessions", async () => {
    const result = await resolveZulipTopicContext({
      client: DUMMY_CLIENT,
      kind: "stream",
      streamName: "engineering",
      topic: "deploy",
      currentMessageId: 17,
      botUserId: 999,
      initialHistoryLimit: 20,
      sessionPreviousTimestamp: Date.now(),
      formatInboundEnvelope: (envelope) => envelope.body,
    });

    expect(result.threadLabel).toBe("Zulip topic #engineering > deploy");
    expect(result.isFirstTopicTurn).toBe(false);
    expect(result.threadHistoryBody).toBeUndefined();
    expect(mockedFetchZulipMessages).not.toHaveBeenCalled();
  });

  it("does not fetch when history limit is disabled", async () => {
    const result = await resolveZulipTopicContext({
      client: DUMMY_CLIENT,
      kind: "stream",
      streamName: "engineering",
      topic: "deploy",
      currentMessageId: 17,
      botUserId: 999,
      initialHistoryLimit: 0,
      sessionPreviousTimestamp: undefined,
      formatInboundEnvelope: (envelope) => envelope.body,
    });

    expect(result.threadLabel).toBe("Zulip topic #engineering > deploy");
    expect(result.isFirstTopicTurn).toBe(true);
    expect(result.threadHistoryBody).toBeUndefined();
    expect(mockedFetchZulipMessages).not.toHaveBeenCalled();
  });

  it("skips topic history for DMs", async () => {
    const result = await resolveZulipTopicContext({
      client: DUMMY_CLIENT,
      kind: "dm",
      streamName: "",
      topic: "",
      currentMessageId: 17,
      botUserId: 999,
      initialHistoryLimit: 20,
      sessionPreviousTimestamp: undefined,
      formatInboundEnvelope: (envelope) => envelope.body,
    });

    expect(result.threadLabel).toBeUndefined();
    expect(result.isFirstTopicTurn).toBe(false);
    expect(result.threadHistoryBody).toBeUndefined();
    expect(mockedFetchZulipMessages).not.toHaveBeenCalled();
  });

  it("fails open when Zulip history API throws", async () => {
    mockedFetchZulipMessages.mockRejectedValueOnce(new Error("zulip timeout"));
    const verboseLog = vi.fn();

    const result = await resolveZulipTopicContext({
      client: DUMMY_CLIENT,
      kind: "stream",
      streamName: "engineering",
      topic: "deploy",
      currentMessageId: 17,
      botUserId: 999,
      initialHistoryLimit: 20,
      sessionPreviousTimestamp: undefined,
      formatInboundEnvelope: (envelope) => envelope.body,
      logVerbose: verboseLog,
    });

    expect(result.threadLabel).toBe("Zulip topic #engineering > deploy");
    expect(result.isFirstTopicTurn).toBe(true);
    expect(result.threadHistoryBody).toBeUndefined();
    expect(verboseLog).not.toHaveBeenCalled();
  });
});

describe("resolveZulipComponentReplyTarget", () => {
  it("prefers the originating reply target when present", () => {
    expect(
      resolveZulipComponentReplyTarget({
        replyTo: "stream:ops:topic:deploy",
        senderId: 42,
      }),
    ).toBe("stream:ops:topic:deploy");
  });

  it("falls back to DM for legacy entries without reply routing", () => {
    expect(
      resolveZulipComponentReplyTarget({
        replyTo: undefined,
        senderId: 42,
      }),
    ).toBe("dm:42");
  });
});
