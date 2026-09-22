import { describe, expect, it } from "vitest";
import {
  getSlackQaMessageWriteCursor,
  readSlackQaNativeWrites,
  readSlackQaMessageWrites,
} from "./slack-live.capture.js";

function buildMessageRequest(params: {
  channel?: string;
  flowId: string;
  method?: string;
  text: string;
  threadTs?: string;
  ts?: string;
}): Record<string, unknown> {
  return {
    dataText: new URLSearchParams({
      channel: params.channel ?? "C123",
      text: params.text,
      ...(params.threadTs ? { thread_ts: params.threadTs } : {}),
      ...(params.ts ? { ts: params.ts } : {}),
    }).toString(),
    flowId: params.flowId,
    host: "slack.com",
    kind: "request",
    method: "POST",
    path: `/api/${params.method ?? "chat.postMessage"}`,
  };
}

function buildResponse(
  flowId: string,
  ok: boolean,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    dataText: JSON.stringify({ channel: "C123", ok, ts: "2.000000", ...overrides }),
    flowId,
    kind: "response",
    status: 200,
  };
}

describe("Slack QA debug capture", () => {
  it("preserves only successful Slack post and update snapshots", async () => {
    const postRequest = buildMessageRequest({
      flowId: "post",
      text: "fallback",
      threadTs: "1.000000",
    });
    postRequest.dataText = new URLSearchParams({
      channel: "C123",
      text: "fallback",
      blocks: JSON.stringify([
        { type: "header", text: { type: "plain_text", text: "Update" } },
        { type: "section", text: { type: "mrkdwn", text: "COMMENTARY" } },
      ]),
      thread_ts: "1.000000",
    }).toString();
    const events = [
      buildResponse("update", true),
      {
        id: 4,
        ...buildMessageRequest({
          flowId: "update",
          method: "chat.update",
          text: "receipt",
          ts: "2.000000",
        }),
      },
      buildResponse("post", true),
      { id: 3, ...postRequest },
      buildResponse("rejected", false),
      { id: 2, ...buildMessageRequest({ flowId: "rejected", text: "REJECTED" }) },
      buildResponse("non-write", true),
      {
        id: 1,
        ...buildMessageRequest({ flowId: "non-write", method: "auth.test", text: "IGNORED" }),
      },
    ];
    const store = {
      getSessionEvents: () => events,
      readBlob: () => null,
    };

    await expect(
      readSlackQaMessageWrites({
        afterRequestEventId: 0,
        sessionId: "qa-slack",
        store,
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

  it("reads captured request and response blobs when previews are unavailable", async () => {
    const request = buildMessageRequest({ flowId: "blob", text: "BLOB-COMMENTARY" });
    const response = buildResponse("blob", true);
    const blobs = new Map([
      ["request", String(request.dataText)],
      ["response", String(response.dataText)],
    ]);
    delete request.dataText;
    delete response.dataText;
    request.id = 1;
    request.dataBlobId = "request";
    response.dataBlobId = "response";
    const store = {
      getSessionEvents: () => [response, request],
      readBlob: (blobId: string) => blobs.get(blobId) ?? null,
    };

    await expect(
      readSlackQaMessageWrites({
        afterRequestEventId: 0,
        sessionId: "qa-slack",
        store,
      }),
    ).resolves.toEqual([expect.objectContaining({ text: "BLOB-COMMENTARY" })]);
  });

  it("uses request ids as cursors and waits for late response capture", async () => {
    const oldRequest = { id: 4, ...buildMessageRequest({ flowId: "old", text: "OLD" }) };
    const nextRequest = { id: 5, ...buildMessageRequest({ flowId: "next", text: "NEXT" }) };
    let reads = 0;
    const store = {
      getSessionEvents: () => {
        reads += 1;
        return reads < 3 ? [nextRequest, oldRequest] : [buildResponse("next", true), nextRequest];
      },
      readBlob: () => null,
    };

    expect(getSlackQaMessageWriteCursor({ sessionId: "qa-slack", store })).toBe(5);
    await expect(
      readSlackQaMessageWrites({
        afterRequestEventId: 4,
        sessionId: "qa-slack",
        store,
      }),
    ).resolves.toEqual([expect.objectContaining({ text: "NEXT" })]);
  });

  it("separates accepted native mutations from rejected writes and visual evidence", () => {
    const methods = [
      "chat.delete",
      "reactions.add",
      "reactions.remove",
      "files.completeUploadExternal",
      "files.delete",
    ];
    const events = methods.flatMap((method, index) => [
      {
        ...buildResponse(
          method,
          true,
          method === "files.completeUploadExternal"
            ? { files: [{ id: "F_NEW", url_private: "private-url" }] }
            : {},
        ),
        id: index * 2 + 2,
      },
      {
        id: index * 2 + 1,
        ...buildMessageRequest({ flowId: method, method, text: "", ts: "2.000000" }),
        dataText: new URLSearchParams({
          channel: "C123",
          ts: "2.000000",
          thread_ts: "1.000000",
          name: "eyes",
          file: "F_DELETED",
        }).toString(),
      },
    ]);
    events.push(
      { ...buildResponse("rejected", false), id: 12 },
      { id: 11, ...buildMessageRequest({ flowId: "rejected", method: "reactions.add", text: "" }) },
    );
    const writes = readSlackQaNativeWrites({
      afterRequestEventId: 0,
      sessionId: "qa-slack",
      store: { getSessionEvents: () => events.toReversed(), readBlob: () => null },
    });
    expect(writes.map((write) => [write.method, write.evidence])).toEqual(
      methods.map((method) => [method, "api-accepted"]),
    );
    expect(writes.find((write) => write.method === "reactions.add")).toMatchObject({
      messageId: "2.000000",
      emoji: "eyes",
    });
    expect(writes.find((write) => write.method === "files.completeUploadExternal")).toMatchObject({
      fileIds: ["F_NEW"],
      threadId: "1.000000",
    });
    expect(writes.find((write) => write.method === "files.delete")).toMatchObject({
      fileIds: ["F_DELETED"],
    });
    expect(JSON.stringify(writes)).not.toContain("private-url");
  });

  it("retains unresolved mutations without treating read-only calls or rejections as side effects", () => {
    const events: Array<Record<string, unknown>> = [
      {
        id: 1,
        ...buildMessageRequest({ flowId: "old", text: "before cursor" }),
      },
      {
        id: 2,
        ...buildMessageRequest({ flowId: "pending", text: "private-body", threadTs: "1.000000" }),
      },
      {
        id: 3,
        ...buildMessageRequest({
          flowId: "error",
          method: "chat.update",
          text: "",
          ts: "3.000000",
        }),
      },
      {
        id: 4,
        flowId: "error",
        kind: "error",
        errorText: "Authorization: private-token",
        headersJson: '{"authorization":"private-token"}',
      },
      { id: 5, ...buildMessageRequest({ flowId: "rejected", text: "" }) },
      { id: 6, ...buildResponse("rejected", false, { error: "private-error" }), status: 429 },
      {
        id: 7,
        ...buildMessageRequest({ flowId: "read", method: "conversations.history", text: "" }),
      },
      { id: 8, ...buildMessageRequest({ flowId: "undecodable", text: "" }) },
      {
        id: 9,
        ...buildResponse("undecodable", true),
        dataText: '{"ok":true,"private":"truncated',
      },
    ];
    const params = {
      afterRequestEventId: 1,
      sessionId: "qa-slack",
      store: { getSessionEvents: () => events.toReversed(), readBlob: () => null },
    };
    const writes = readSlackQaNativeWrites(params);
    expect(writes).toEqual([
      expect.objectContaining({
        requestEventId: 2,
        method: "chat.postMessage",
        evidence: "uncertain",
        reason: "response-not-captured",
        channelId: "C123",
        threadId: "1.000000",
      }),
      expect.objectContaining({
        requestEventId: 3,
        method: "chat.update",
        evidence: "uncertain",
        reason: "transport-error",
        messageId: "3.000000",
      }),
      expect.objectContaining({
        requestEventId: 8,
        evidence: "uncertain",
        reason: "response-undecodable",
      }),
    ]);
    expect(JSON.stringify(writes)).not.toContain("private-");

    events.push({ id: 10, ...buildResponse("pending", true) });
    const settled = readSlackQaNativeWrites(params);
    expect(settled.find((write) => write.requestEventId === 2)).toMatchObject({
      evidence: "api-accepted",
      messageId: "2.000000",
      threadId: "1.000000",
    });
    expect(settled.find((write) => write.requestEventId === 2)).not.toHaveProperty("reason");
    expect(
      settled
        .filter((write) => write.evidence === "uncertain")
        .map((write) => write.requestEventId),
    ).toEqual([3, 8]);
  });
});
