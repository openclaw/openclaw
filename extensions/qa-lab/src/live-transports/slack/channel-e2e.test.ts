import fs from "node:fs/promises";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSlackChannelE2e } from "./channel-e2e.js";
import { readSlackQaNativeWrites, type SlackNativeWrite } from "./slack-live.capture.js";
import type { SlackMessage } from "./slack-live.contracts.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function fixture(capturedEvents?: Array<Record<string, unknown>>) {
  const controller = new AbortController();
  const messages: SlackMessage[] = [];
  const writes: SlackNativeWrite[] = [];
  let leaseAlive = true;
  let nextId = 1;
  const driverClient = {
    auth: { test: vi.fn(async () => ({ user_id: "U_DRIVER", team_id: "T_QA" })) },
    conversations: { history: vi.fn(async () => ({ messages: [] })) },
    chat: {
      postMessage: vi.fn(async (input: { text: string; thread_ts?: string }) => {
        const ts = `${nextId++}.000000`;
        messages.push({ ts, text: input.text, thread_ts: input.thread_ts, user: "U_DRIVER" });
        return { channel: "C_QA", ts };
      }),
      update: vi.fn(async () => ({ ok: true })),
      delete: vi.fn(async ({ ts }: { ts: string }) => {
        const index = messages.findIndex((message) => message.ts === ts);
        if (index >= 0) {
          messages.splice(index, 1);
        }
        return { ok: true };
      }),
    },
    reactions: {
      add: vi.fn(async () => ({ ok: true })),
      remove: vi.fn(async () => ({ ok: true })),
      get: vi.fn(async () => ({ message: { reactions: [] } })),
    },
    files: { delete: vi.fn(async () => ({ ok: true })) },
  };
  const sutClient = {
    auth: { test: vi.fn(async () => ({ user_id: "U_SUT", team_id: "T_QA" })) },
    conversations: {
      history: vi.fn(async () => ({ messages })),
      replies: vi.fn(async () => ({ messages })),
    },
    chat: { delete: vi.fn(async (_input: { channel: string; ts: string }) => ({ ok: true })) },
    files: { delete: vi.fn(async () => ({ ok: true })) },
  };
  const assertLease = () => {
    if (!leaseAlive) {
      throw new Error("lease expired");
    }
  };
  const session = createSlackChannelE2e({
    channelId: "C_QA",
    driverIdentity: { userId: "U_DRIVER" },
    sutIdentity: { userId: "U_SUT" },
    driverClient: driverClient as never,
    sutClient: sutClient as never,
    sutWriteClient: sutClient as never,
    cleanupDriverClient: driverClient as never,
    cleanupSutClient: sutClient as never,
    assertActive: assertLease,
    assertLease,
    signal: controller.signal,
    waitReady: async () => {},
    outputDir: tempDirs.make("slack-e2e-"),
    scenarioId: "ownership",
    readNativeWrites: async () =>
      capturedEvents
        ? readSlackQaNativeWrites({
            afterRequestEventId: 0,
            sessionId: "qa-slack",
            store: {
              getSessionEvents: () => capturedEvents.toReversed(),
              readBlob: () => null,
            },
          })
        : writes,
  });
  return {
    session,
    controller,
    driverClient,
    sutClient,
    messages,
    writes,
    expire: () => {
      leaseAlive = false;
    },
  };
}

describe("Slack agent E2E ownership", () => {
  it("refuses foreign mutations and cleans only exact driver and correlated Gateway receipts", async () => {
    const f = fixture();
    f.messages.push({ ts: "0.000001", user: "U_OTHER", text: "keep me" });
    const root = await f.session.driver.send({ text: "owned", mention: false });
    await expect(f.session.driver.delete({ messageId: "0.000001" })).rejects.toThrow(
      "owned by this run",
    );
    await expect(f.session.driver.edit({ messageId: "0.000001", text: "wrong" })).rejects.toThrow(
      "owned by this run",
    );
    await expect(
      f.session.driver.react({ messageId: root.id, emoji: "eyes", remove: true }),
    ).rejects.toThrow("add receipt");
    f.writes.push(
      {
        evidence: "api-accepted",
        requestEventId: 1,
        method: "chat.postMessage",
        channelId: "C_QA",
        messageId: "2.000000",
        threadId: root.id,
      },
      {
        evidence: "api-accepted",
        requestEventId: 2,
        method: "chat.postMessage",
        channelId: "C_OTHER",
        messageId: "3.000000",
        threadId: root.id,
      },
      {
        evidence: "api-accepted",
        requestEventId: 3,
        method: "chat.postMessage",
        channelId: "C_QA",
        messageId: "4.000000",
        threadId: "0.000001",
      },
    );
    await f.session.cleanup();
    expect(f.messages).toEqual([{ ts: "0.000001", user: "U_OTHER", text: "keep me" }]);
    expect(f.sutClient.chat.delete.mock.calls.map(([input]) => input)).toEqual([
      { channel: "C_QA", ts: "2.000000" },
    ]);
  });

  it("retains a late native receipt after cancellation for post-stop cleanup", async () => {
    const f = fixture();
    const started = createDeferred<void>();
    const response = createDeferred<{ channel: string; ts: string }>();
    f.driverClient.chat.postMessage.mockImplementationOnce(async () => {
      started.resolve();
      return await response.promise;
    });
    const sending = f.session.driver.send({ text: "late receipt" });
    const rejected = expect(sending).rejects.toThrow("cancel fixture");
    await started.promise;
    f.controller.abort(new Error("cancel fixture"));
    response.resolve({ channel: "C_QA", ts: "7.000000" });
    await rejected;
    await expect(f.session.driver.send({ text: "must not dispatch" })).rejects.toThrow(
      "cancel fixture",
    );
    await f.session.cleanup();
    expect(f.driverClient.chat.postMessage).toHaveBeenCalledTimes(1);
    expect(f.driverClient.chat.delete).toHaveBeenCalledWith({ channel: "C_QA", ts: "7.000000" });
    const artifact = JSON.parse(await fs.readFile(f.session.artifactPath, "utf8"));
    expect(artifact.ownedMessages).toEqual([
      expect.objectContaining({
        deleted: true,
        message: expect.objectContaining({ id: "7.000000" }),
      }),
    ]);
  });

  it("retains an ambiguous send as incomplete instead of guessing a deletion target", async () => {
    const f = fixture();
    f.driverClient.chat.postMessage.mockRejectedValueOnce(
      new Error("connection closed after dispatch"),
    );
    await expect(f.session.driver.send({ text: "unknown outcome" })).rejects.toThrow(
      "without a definitive Slack receipt",
    );
    await expect(f.session.cleanup()).rejects.toThrow("1 uncertain operations");
    expect(f.driverClient.chat.delete).not.toHaveBeenCalled();
    const artifact = JSON.parse(await fs.readFile(f.session.artifactPath, "utf8"));
    expect(artifact.evidence).toContainEqual(
      expect.objectContaining({ operation: "chat.postMessage", outcome: "uncertain" }),
    );
  });

  it.each([
    { stage: "readiness", operation: "driver auth.test" },
    { stage: "mutation", operation: "chat.postMessage" },
  ])("preserves only sanitized SDK failure context during $stage", async ({ stage, operation }) => {
    const f = fixture();
    const failure = Object.assign(new Error("Authorization: secret-fixture"), {
      data: { error: "missing_scope", needed: "chat:write" },
      headers: { authorization: "secret-fixture" },
      cause: new Error("secret-fixture"),
    });
    const action =
      stage === "readiness" ? f.driverClient.auth.test : f.driverClient.chat.postMessage;
    action.mockRejectedValueOnce(failure);

    await expect(f.session.driver.send({ text: "sanitized failure" })).rejects.toMatchObject({
      message: `Slack ${operation}: missing_scope; needed=chat:write`,
      cause: "missing_scope; needed=chat:write",
    });
  });

  it.each([
    { terminal: "unanswered", outcome: "uncertain", reason: "response-not-captured" },
    { terminal: "error", outcome: "uncertain", reason: "transport-error" },
    { terminal: "undecodable", outcome: "uncertain", reason: "response-undecodable" },
    { terminal: "server-error", outcome: "uncertain", reason: "response-indeterminate" },
    { terminal: "partial-failure", outcome: "uncertain", reason: "response-indeterminate" },
    { terminal: "rejected", outcome: undefined, reason: undefined },
    { terminal: "accepted-after-error", outcome: "api-accepted", reason: undefined },
  ])(
    "preserves Gateway $terminal evidence without guessing cleanup targets",
    async ({ terminal, outcome, reason }) => {
      const events: Array<Record<string, unknown>> = [];
      const f = fixture(events);
      const root = await f.session.driver.send({ text: "owned root", mention: false });
      events.push({
        id: 1,
        flowId: "gateway-write",
        host: "slack.com",
        kind: "request",
        method: "POST",
        path: "/api/chat.postMessage",
        dataText: new URLSearchParams({
          channel: "C_QA",
          thread_ts: root.id,
          ts: "2.000000",
          text: "private-body",
          token: "private-token",
        }).toString(),
      });
      if (terminal === "error" || terminal === "accepted-after-error") {
        events.push({
          id: 2,
          flowId: "gateway-write",
          kind: "error",
          errorText: "Authorization: private-token",
        });
      }
      if (terminal !== "unanswered" && terminal !== "error") {
        events.push({
          id: 3,
          flowId: "gateway-write",
          kind: "response",
          status: terminal === "server-error" ? 503 : 200,
          dataText:
            terminal === "undecodable"
              ? '{"ok":true,"private":"truncated'
              : JSON.stringify({
                  ok: terminal === "accepted-after-error",
                  channel: "C_QA",
                  ts: "2.000000",
                  error: terminal === "partial-failure" ? "fatal_error" : "missing_scope",
                  detail: "private-error",
                }),
        });
      }

      if (outcome === "uncertain") {
        await expect(f.session.cleanup()).rejects.toThrow("1 uncertain operations");
      } else {
        await f.session.cleanup();
      }
      expect(f.driverClient.chat.delete).toHaveBeenCalledWith({ channel: "C_QA", ts: root.id });
      if (outcome === "api-accepted") {
        expect(f.sutClient.chat.delete).toHaveBeenCalledWith({ channel: "C_QA", ts: "2.000000" });
      } else {
        expect(f.sutClient.chat.delete).not.toHaveBeenCalled();
      }
      expect(f.sutClient.files.delete).not.toHaveBeenCalled();
      const content = await fs.readFile(f.session.artifactPath, "utf8");
      expect(content).not.toContain("private-");
      const artifact = JSON.parse(content);
      const gatewayEvidence = artifact.evidence.filter(
        (entry: { operation: string }) => entry.operation === "Gateway chat.postMessage",
      );
      expect(gatewayEvidence).toEqual(
        outcome
          ? [
              expect.objectContaining({
                outcome,
                requestEventId: 1,
                channelId: "C_QA",
                threadId: root.id,
                messageId: "2.000000",
                ...(reason ? { detail: reason } : {}),
              }),
            ]
          : [],
      );
    },
  );

  it("performs no cleanup writes after lease authority is lost", async () => {
    const f = fixture();
    await f.session.driver.send({ text: "retained" });
    f.expire();
    await expect(f.session.cleanup()).rejects.toThrow("cleanup incomplete");
    expect(f.driverClient.chat.delete).not.toHaveBeenCalled();
    expect(f.messages[0]?.text).toContain("retained");
  });

  it("reports failed cleanup without leaking SDK headers or discarding the owned receipt", async () => {
    const f = fixture();
    const sent = await f.session.driver.send({ text: "keep recovery evidence" });
    f.driverClient.chat.delete.mockRejectedValueOnce(
      Object.assign(new Error("Authorization: secret-fixture"), {
        data: { error: "missing_scope", needed: "chat:write" },
      }),
    );
    await expect(f.session.cleanup()).rejects.toThrow("cleanup incomplete");
    const content = await fs.readFile(f.session.artifactPath, "utf8");
    expect(content).not.toContain("secret-fixture");
    const artifact = JSON.parse(content);
    expect(artifact.evidence).toContainEqual(
      expect.objectContaining({
        operation: "cleanup chat.delete",
        outcome: "failed",
        detail: "missing_scope; needed=chat:write",
      }),
    );
    expect(artifact.ownedMessages).toContainEqual({
      message: expect.objectContaining({ id: sent.id }),
    });
  });

  it("does not mistake reaction API acceptance for stored state", async () => {
    const f = fixture();
    const sent = await f.session.driver.send({ text: "reaction target", mention: false });
    await expect(f.session.driver.react({ messageId: sent.id, emoji: "eyes" })).rejects.toThrow(
      "did not match stored",
    );
    await f.session.cleanup();
    expect(f.driverClient.reactions.remove).toHaveBeenCalledWith({
      channel: "C_QA",
      timestamp: sent.id,
      name: "eyes",
    });
  });

  it("correlates paginated SUT replies and preserves merely observed file identities", async () => {
    const f = fixture();
    const root = await f.session.driver.send({ text: "root", mention: false });
    f.sutClient.conversations.replies
      .mockResolvedValueOnce({
        messages: [{ ts: "2.000000", thread_ts: root.id, user: "U_OTHER", text: "EXACT" }],
        response_metadata: { next_cursor: "next-page" },
      } as never)
      .mockResolvedValueOnce({
        messages: [
          { ts: "3.000000", thread_ts: "different-root", user: "U_SUT", text: "EXACT" },
          {
            ts: "4.000000",
            thread_ts: root.id,
            user: "U_SUT",
            text: "EXACT",
            files: [{ id: "F_EXISTING", name: "existing.txt" }],
          },
        ],
      });
    const reply = await f.session.driver.waitForReply({
      afterMessageId: root.id,
      threadId: root.id,
      textIncludes: "EXACT",
    });
    expect(reply).toMatchObject({
      id: "4.000000",
      actor: "sut",
      attachments: [{ id: "F_EXISTING", name: "existing.txt" }],
    });
    await f.session.cleanup();
    expect(f.sutClient.files.delete).not.toHaveBeenCalled();
    expect(f.sutClient.chat.delete).toHaveBeenCalledWith({ channel: "C_QA", ts: "4.000000" });
  });

  it("reports optional missing scopes while allowing text and refusing unavailable native effects", async () => {
    const f = fixture();
    f.driverClient.auth.test.mockResolvedValueOnce({
      user_id: "U_DRIVER",
      team_id: "T_QA",
      response_metadata: { scopes: ["chat:write", "groups:history"] },
    } as never);
    const doctor = await f.session.driver.doctor();
    expect(doctor.ok).toBe(false);
    expect(doctor.capabilities.unavailable).toContainEqual(
      expect.objectContaining({ capability: "driver files:write" }),
    );
    expect(f.driverClient.chat.postMessage).not.toHaveBeenCalled();
    const sent = await f.session.driver.send({
      text: "basic text remains available",
      mention: false,
    });
    expect(sent.text).toBe("basic text remains available");
    await expect(f.session.driver.react({ messageId: sent.id, emoji: "eyes" })).rejects.toThrow(
      "driver missing_scope; needed=reactions:read, reactions:write",
    );
    expect(f.driverClient.reactions.add).not.toHaveBeenCalled();
    await expect(
      f.session.driver.upload({ path: "/not-read-with-missing-scopes" }),
    ).rejects.toThrow("driver missing_scope; needed=files:read, files:write");
    await f.session.cleanup();
  });
});
