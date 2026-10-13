import { describe, expect, it } from "vitest";
import {
  getSlackQaMessageWriteCursor,
  readSlackQaNativeWrites,
  readSlackQaMessageWrites,
} from "./slack-live.capture.js";

function request(id: number, method: string, fields: Record<string, string> = {}) {
  return {
    id,
    flowId: String(id),
    host: "slack.com",
    kind: "request",
    method: "POST",
    path: `/api/${method}`,
    dataText: new URLSearchParams({ channel: "C123", ...fields }).toString(),
  };
}
function response(id: number, fields: Record<string, unknown> = {}) {
  return {
    flowId: String(id),
    kind: "response",
    status: 200,
    dataText: JSON.stringify({ channel: "C123", ok: true, ts: "2.000000", ...fields }),
  };
}

describe("Slack QA debug capture", () => {
  it("reads successful inline and blob-backed writes in request order", async () => {
    const post = request(3, "chat.postMessage", {
      text: "fallback",
      thread_ts: "1.000000",
      blocks: JSON.stringify([
        { type: "header", text: { type: "plain_text", text: "Update" } },
        { type: "section", text: { type: "mrkdwn", text: "COMMENTARY" } },
      ]),
    });
    const posted = response(3);
    const blobs = new Map([
      ["request", post.dataText],
      ["response", posted.dataText],
    ]);
    const events = [
      response(4),
      request(4, "chat.update", { text: "receipt", ts: "2.000000" }),
      { ...posted, dataText: undefined, dataBlobId: "response" },
      { ...post, dataText: undefined, dataBlobId: "request" },
      response(2, { ok: false }),
      request(2, "chat.postMessage", { text: "REJECTED" }),
      response(1),
      request(1, "auth.test", { text: "IGNORED" }),
    ];
    await expect(
      readSlackQaMessageWrites({
        afterRequestEventId: 0,
        sessionId: "qa-slack",
        store: {
          getSessionEvents: async () => events,
          readBlob: async (id: string) => blobs.get(id) ?? null,
        },
      }),
    ).resolves.toEqual([
      {
        blockText: ["Update", "COMMENTARY"],
        channelId: "C123",
        text: "fallback",
        threadTs: "1.000000",
        ts: "2.000000",
      },
      { channelId: "C123", text: "receipt", ts: "2.000000" },
    ]);
  });

  it("uses request ids as cursors and waits for late response capture", async () => {
    const old = request(4, "chat.postMessage", { text: "OLD" });
    const next = request(5, "chat.postMessage", { text: "NEXT" });
    let reads = 0;
    const store = {
      getSessionEvents: async () => (++reads < 3 ? [next, old] : [response(5), next]),
      readBlob: async () => null,
    };
    await expect(getSlackQaMessageWriteCursor({ sessionId: "qa-slack", store })).resolves.toBe(5);
    await expect(
      readSlackQaMessageWrites({ afterRequestEventId: 4, sessionId: "qa-slack", store }),
    ).resolves.toEqual([expect.objectContaining({ text: "NEXT" })]);
  });

  it("classifies native mutations and settles pending writes without exposing private data", async () => {
    const methods = [
      "chat.delete",
      "reactions.add",
      "reactions.remove",
      "files.completeUploadExternal",
      "files.delete",
    ];
    const events: Array<Record<string, unknown>> = [
      request(1, "chat.postMessage", { text: "before cursor" }),
      ...methods.flatMap((method, index) => [
        request(index + 2, method, {
          ts: "2.000000",
          thread_ts: "1.000000",
          name: "eyes",
          file: "F_DELETED",
        }),
        response(
          index + 2,
          method === "files.completeUploadExternal"
            ? { files: [{ id: "F_NEW", url_private: "private-url" }] }
            : {},
        ),
      ]),
      request(7, "chat.postMessage", { text: "private-body", thread_ts: "1.000000" }),
      request(8, "chat.update", { ts: "3.000000" }),
      {
        flowId: "8",
        kind: "error",
        errorText: "Authorization: private-token",
        headersJson: '{"authorization":"private-token"}',
      },
      request(9, "reactions.add"),
      { ...response(9, { ok: false, error: "private-error" }), status: 429 },
      request(10, "conversations.history"),
      request(11, "chat.postMessage"),
      { ...response(11), dataText: '{"ok":true,"private":"truncated' },
    ];
    const params = {
      afterRequestEventId: 1,
      sessionId: "qa-slack",
      store: { getSessionEvents: async () => events.toReversed(), readBlob: async () => null },
    };
    const writes = await readSlackQaNativeWrites(params);
    expect(writes.slice(0, 5).map((write) => [write.method, write.evidence])).toEqual(
      methods.map((method) => [method, "api-accepted"]),
    );
    expect(writes[1]).toMatchObject({ messageId: "2.000000", emoji: "eyes" });
    expect(writes[3]).toMatchObject({ fileIds: ["F_NEW"], threadId: "1.000000" });
    expect(writes[4]).toMatchObject({ fileIds: ["F_DELETED"] });
    expect(writes.slice(5)).toEqual([
      expect.objectContaining({
        requestEventId: 7,
        method: "chat.postMessage",
        evidence: "uncertain",
        reason: "response-not-captured",
        channelId: "C123",
        threadId: "1.000000",
      }),
      expect.objectContaining({
        requestEventId: 8,
        method: "chat.update",
        evidence: "uncertain",
        reason: "transport-error",
        messageId: "3.000000",
      }),
      expect.objectContaining({
        requestEventId: 11,
        evidence: "uncertain",
        reason: "response-undecodable",
      }),
    ]);
    expect(JSON.stringify(writes)).not.toContain("private-");
    events.push(response(7));
    const settled = await readSlackQaNativeWrites(params);
    expect(settled.find((write) => write.requestEventId === 7)).toMatchObject({
      evidence: "api-accepted",
      messageId: "2.000000",
      threadId: "1.000000",
    });
    expect(settled.find((write) => write.requestEventId === 7)).not.toHaveProperty("reason");
    expect(
      settled
        .filter((write) => write.evidence === "uncertain")
        .map((write) => write.requestEventId),
    ).toEqual([8, 11]);
  });
});
