import type { ConversationReference } from "@microsoft/teams.api";
import { HttpStream } from "@microsoft/teams.apps/dist/http/http-stream.js";
// Repro for MS Teams long-reply double-post via real @microsoft/teams.apps HttpStream.
// Only the Bot Framework conversations.activities create/update API is mocked.
import { describe, expect, it } from "vitest";
import { createTeamsReplyStreamController } from "./reply-stream-controller.js";

type SentActivity = Record<string, unknown> & {
  id?: string;
  type?: string;
  text?: string;
  entities?: Array<{ type?: string; streamType?: string }>;
  channelData?: { streamType?: string; streamId?: string };
};

type ActivityCall = {
  kind: "create" | "update";
  activity: SentActivity;
};

function makeMockClient() {
  const calls: ActivityCall[] = [];
  let nextId = 1;

  const client = {
    conversations: {
      activities: (_convId: string) => ({
        create: async (activity: SentActivity) => {
          const id = `msg-${nextId++}`;
          const sent = { ...activity, id };
          calls.push({ kind: "create", activity: sent });
          return { id };
        },
        update: async (id: string, activity: SentActivity) => {
          const sent = { ...activity, id };
          calls.push({ kind: "update", activity: sent });
          return { id };
        },
      }),
    },
  };

  return { client, calls };
}

function makeRef(): ConversationReference {
  return {
    bot: { id: "28:bot", name: "OpenClaw" },
    conversation: { id: "19:conv@thread.v2" },
  } as ConversationReference;
}

async function settleHttpStream(stream: HttpStream): Promise<void> {
  // HttpStream.flush() is async and close() polls until the queue drains.
  for (let i = 0; i < 50; i += 1) {
    await stream.flush();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function hasStreamInfoEntity(activity: SentActivity): boolean {
  return activity.entities?.some((entity) => entity.type === "streaminfo") ?? false;
}

function streamInfoType(activity: SentActivity): string | undefined {
  return activity.entities?.find((entity) => entity.type === "streaminfo")?.streamType;
}

function summarizeCalls(calls: ActivityCall[]) {
  const creates = calls.filter((call) => call.kind === "create");
  const updates = calls.filter((call) => call.kind === "update");
  const typingCreates = creates.filter((call) => call.activity.type === "typing");
  const messageCreates = creates.filter((call) => call.activity.type === "message");
  const finalCreates = messageCreates.filter((call) => streamInfoType(call.activity) === "final");
  const streamingCreates = [
    ...typingCreates.filter((call) => hasStreamInfoEntity(call.activity)),
    ...messageCreates.filter((call) => streamInfoType(call.activity) === "streaming"),
  ];
  return {
    createCount: creates.length,
    updateCount: updates.length,
    typingCreateCount: typingCreates.length,
    messageCreateCount: messageCreates.length,
    finalCreateCount: finalCreates.length,
    streamingCreateCount: streamingCreates.length,
    finalCreates,
    lastStreamingText: streamingCreates.at(-1)?.activity.text,
    finalText: finalCreates.at(-1)?.activity.text,
  };
}

/** Drive openclaw's cumulative partial-reply pattern through the real controller + HttpStream. */
async function driveOpenClawLongReply(params: {
  fullText: string;
  chunkChars: number;
  feedbackLoopEnabled?: boolean;
}) {
  const { client, calls } = makeMockClient();
  const httpStream = new HttpStream(client as never, makeRef());
  const ctrl = createTeamsReplyStreamController({
    conversationType: "personal",
    context: { stream: httpStream } as never,
    feedbackLoopEnabled: params.feedbackLoopEnabled ?? false,
  });

  let blockDeliveries: Array<string | undefined> = [];
  for (let len = params.chunkChars; len < params.fullText.length; len += params.chunkChars) {
    ctrl.onPartialReply({ text: params.fullText.slice(0, len) });
    await settleHttpStream(httpStream);
  }
  ctrl.onPartialReply({ text: params.fullText });
  await settleHttpStream(httpStream);

  const prepared = ctrl.preparePayload({ text: params.fullText });
  if (prepared?.text !== undefined) {
    blockDeliveries.push(prepared.text);
  } else if (prepared === undefined) {
    blockDeliveries.push(undefined);
  } else {
    blockDeliveries.push(prepared.text);
  }

  await ctrl.finalize();
  await settleHttpStream(httpStream);

  return { calls, blockDeliveries, summary: summarizeCalls(calls) };
}

describe("MS Teams HttpStream long-reply repro (real SDK, mocked transport)", () => {
  it("long single-shot reply (>4000 chars): preview stream create + final create both carry full text", async () => {
    const fullText = `Long reply ${"word ".repeat(900)}`.slice(0, 4500);
    expect(fullText.length).toBeGreaterThan(4000);

    const { summary, blockDeliveries } = await driveOpenClawLongReply({
      fullText,
      chunkChars: 400,
    });

    // openclaw suppresses block delivery on the happy path — duplicate is not from (c).
    expect(blockDeliveries).toEqual([undefined]);

    // SDK ships streaming preview chunks as CREATEs (with streaminfo), not UPDATEs.
    expect(summary.updateCount).toBe(0);
    expect(summary.streamingCreateCount).toBeGreaterThan(1);

    // Without the plugin fix, the SDK close() adds a second full-text CREATE that Teams
    // may fail to collapse into the preview card for long replies.
    expect(summary.finalCreateCount).toBe(0);

    expect(summary.lastStreamingText).toBe(fullText);
    expect(summary.finalText).toBeUndefined();
  });

  it("short reply uses the same SDK create+final pattern but with fewer preview chunks", async () => {
    const fullText = "Short hello from OpenClaw.";
    const { summary, blockDeliveries } = await driveOpenClawLongReply({
      fullText,
      chunkChars: 8,
    });

    expect(blockDeliveries).toEqual([undefined]);
    expect(summary.updateCount).toBe(0);
    expect(summary.finalCreateCount).toBe(1);
    expect(summary.finalText).toBe(fullText);
    expect(summary.lastStreamingText).toBe(fullText);
    expect(summary.streamingCreateCount).toBeGreaterThanOrEqual(1);
  });

  it("documents unfixed SDK behavior: raw HttpStream close() CREATEs a streaminfo final with full text", async () => {
    const fullText = "x".repeat(4200);
    const { client, calls } = makeMockClient();
    const stream = new HttpStream(client as never, makeRef());

    // HttpStream appends each emit(); drive deltas like openclaw's controller does.
    let emitted = 0;
    for (let len = 500; len < fullText.length; len += 500) {
      stream.emit(fullText.slice(emitted, len));
      emitted = len;
      await settleHttpStream(stream);
    }
    stream.emit(fullText.slice(emitted));
    await settleHttpStream(stream);
    await stream.close();
    await settleHttpStream(stream);

    const summary = summarizeCalls(calls);
    expect(summary.updateCount).toBe(0);
    expect(summary.finalCreateCount).toBe(1);
    expect(summary.finalText).toBe(fullText);
    expect(summary.lastStreamingText).toBe(fullText);
  });

  it("openclaw long-reply fix suppresses the SDK final CREATE while short replies still finalize", async () => {
    const longText = "y".repeat(4100);
    const longResult = await driveOpenClawLongReply({ fullText: longText, chunkChars: 300 });
    expect(longResult.summary.finalCreateCount).toBe(0);
    expect(longResult.summary.lastStreamingText).toBe(longText);

    const shortText = "Brief answer.";
    const shortResult = await driveOpenClawLongReply({ fullText: shortText, chunkChars: 4 });
    expect(shortResult.summary.finalCreateCount).toBe(1);
    expect(shortResult.summary.finalText).toBe(shortText);
  });
});
