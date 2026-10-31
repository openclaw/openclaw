import { expect, it } from "vitest";
import {
  slackRequest as request,
  slackResponse as response,
} from "./slack-capture.test-helpers.js";
import {
  getSlackQaMessageWriteCursor,
  readSlackQaNativeWrites,
  readSlackQaMessageWrites,
} from "./slack-live.capture.js";

const channelId = "C123";
const messageId = "2.000000";
const threadId = "1.000000";

it("reads successful inline and blob-backed writes in request order", async () => {
  const post = request(3, "chat.postMessage", {
    text: "fallback",
    thread_ts: threadId,
    blocks: JSON.stringify([
      { type: "header", text: { type: "plain_text", text: "Update" } },
      { type: "section", text: { type: "mrkdwn", text: "COMMENTARY" } },
    ]),
  });
  const posted = response(3);
  const blobs = new Map(Object.entries({ request: post.dataText, response: posted.dataText }));
  const events = [
    { ...response(6), status: 500, dataText: undefined, dataBlobId: "failed-response" },
    request(6, "chat.postMessage", { text: "FAILED" }),
    response(4),
    request(4, "chat.update", { text: "receipt", ts: messageId }),
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
        readBlob: async (id: string) => {
          if (id === "failed-response") {
            throw new Error("Failed responses are not message evidence");
          }
          return blobs.get(id) ?? null;
        },
      },
    }),
  ).resolves.toEqual([
    { blockText: ["Update", "COMMENTARY"], channelId, text: "fallback", ts: messageId },
    { channelId, text: "receipt", ts: messageId },
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
  const mutations = [
    ["chat.delete", {}],
    ["reactions.add", { messageId, emoji: "eyes" }],
    ["reactions.remove", {}],
    ["files.completeUploadExternal", { fileIds: ["F_NEW"], threadId }],
    ["files.delete", { fileIds: ["F_DELETED"] }],
  ] as const;
  const upload = { files: [{ id: "F_NEW", url_private: "private-url" }] };
  const events: Array<Record<string, unknown>> = [
    request(1, "chat.postMessage", { text: "before cursor" }),
    ...mutations.flatMap(([method], index) => [
      request(index + 2, method, {
        ts: messageId,
        thread_ts: threadId,
        name: "eyes",
        file: "F_DELETED",
      }),
      response(index + 2, method === "files.completeUploadExternal" ? upload : {}),
    ]),
    request(7, "chat.postMessage", { text: "private-body", thread_ts: threadId }),
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
  expect(writes.slice(0, 5)).toMatchObject(
    mutations.map(([method, fields]) =>
      Object.assign({ method, evidence: "api-accepted" }, fields),
    ),
  );
  expect(
    writes.slice(5).map(({ requestEventId: id, evidence, reason }) => [id, evidence, reason]),
  ).toEqual([
    [7, "uncertain", "response-not-captured"],
    [8, "uncertain", "transport-error"],
    [11, "uncertain", "response-undecodable"],
  ]);
  expect(writes[5]).toMatchObject({ method: "chat.postMessage", channelId, threadId });
  expect(writes[6]).toMatchObject({ method: "chat.update", messageId: "3.000000" });
  expect(JSON.stringify(writes)).not.toContain("private-");
  events.push(response(7), response(8), { flowId: "8", kind: "error" });
  const settled = await readSlackQaNativeWrites(params);
  const settledPost = settled.find((write) => write.requestEventId === 7);
  expect(settledPost).toMatchObject({ evidence: "api-accepted", messageId, threadId });
  expect(settledPost).not.toHaveProperty("reason");
  expect(settled[6]).toMatchObject({ requestEventId: 8, evidence: "api-accepted" });
  const pending = settled.filter((write) => write.evidence === "uncertain");
  expect(pending).toMatchObject([{ requestEventId: 11 }]);
});
