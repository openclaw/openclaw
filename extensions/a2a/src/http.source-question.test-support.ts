import { expect, it } from "vitest";
import type { dispatchA2aInbound } from "./inbound.js";
import { A2A_BUSINESS_INPUT_EXTENSION as U, type A2aTaskRecord } from "./protocol.js";
import type { A2aTaskStore } from "./task-store.js";

type HttpReply = { status: number; json(): Promise<unknown>; text(): Promise<string> };
type Inbound = Parameters<typeof dispatchA2aInbound>[0];

/** Register source-input cases against the same HTTP owner fixture as the protocol suite. */
export function registerA2aSourceQuestionHttpCases({
  startHttpHarness,
  expectReply,
  rpc,
  rpcError,
  taskResult,
  sendRequest,
}: {
  startHttpHarness: (options: { onDispatch: (message: Inbound) => Promise<void> }) => Promise<{
    post: (body: unknown, token?: string | null, businessInput?: boolean) => Promise<HttpReply>;
    onDispatch: (message: Inbound) => Promise<void>;
    taskStore: A2aTaskStore;
  }>;
  expectReply: (
    reply: HttpReply | Promise<HttpReply>,
    expected: object,
    status?: number,
  ) => Promise<HttpReply>;
  rpc: (method: string, params?: unknown, id?: string | number | null) => unknown;
  rpcError: (code: number, message?: unknown) => object;
  taskResult: (task: unknown) => object;
  sendRequest: (params: { text: string }) => unknown;
}) {
  it("returns a negotiated INPUT_REQUIRED task promptly and deduplicates answer admission", async () => {
    const question = {
      version: 1 as const,
      questions: [
        {
          id: "seats",
          header: "Seats",
          question: "How many seats?",
          options: [{ label: "100" }, { label: "200" }],
        },
      ],
      expiresAtMs: Date.now() + 60_000,
      signal: new AbortController().signal,
    };
    const harness = await startHttpHarness({
      onDispatch: async (message) => {
        if (message.answer) {
          expect(message.answer.question).toBe(question);
          await message.answer.onReceipt({ status: "confirmed", resolutionId: "native-receipt" });
        } else {
          expect(message.allowBusinessInput).toBe(true);
          await message.store.requireInput(message.taskId, question);
        }
      },
    });
    const initial = rpc("SendMessage", {
      message: {
        messageId: "initial",
        role: "user",
        parts: [{ text: "Ask me how many seats" }],
        extensions: [U],
      },
    });
    const response = await harness.post(initial, "alpha-secret", true);
    const task = ((await response.json()) as { result: { task: A2aTaskRecord } }).result.task;
    if (task.status.state !== "TASK_STATE_INPUT_REQUIRED") {
      throw new Error("Question is missing");
    }
    const answer = rpc("SendMessage", {
      message: {
        taskId: task.id,
        contextId: task.contextId,
        messageId: "answer",
        role: "user",
        parts: [{ text: "100" }],
        extensions: [U],
        metadata: { [U]: { replyToMessageId: task.status.message.messageId } },
      },
      configuration: { returnImmediately: true },
    });
    await expectReply(harness.post(answer), rpcError(-32004));
    await expectReply(harness.post(answer, "beta-secret", true), rpcError(-32001));
    await expectReply(
      harness.post(answer, "alpha-secret", true),
      taskResult({ id: task.id, status: { state: "TASK_STATE_WORKING" } }),
    );
    await expectReply(
      harness.post(answer, "alpha-secret", true),
      taskResult({ id: task.id, status: { state: "TASK_STATE_WORKING" } }),
    );
    await expectReply(
      harness.post(
        rpc("SendMessage", {
          message: {
            taskId: task.id,
            contextId: task.contextId,
            messageId: "answer",
            role: "user",
            parts: [{ text: "200" }],
            extensions: [U],
            metadata: { [U]: { replyToMessageId: task.status.message.messageId } },
          },
          configuration: { returnImmediately: true },
        }),
        "alpha-secret",
        true,
      ),
      rpcError(-32602),
    );
    expect(harness.onDispatch).toHaveBeenCalledTimes(2);
    expect(harness.taskStore.get(task.id, "alpha")?.artifacts).toEqual([]);
  });

  it("admits explicit empty continuation text while refusing an empty new task", async () => {
    const question = {
      version: 1 as const,
      questions: [{ id: "note", header: "Note", question: "Optional note?", allowEmpty: true }],
      expiresAtMs: Date.now() + 60_000,
      signal: new AbortController().signal,
    };
    const harness = await startHttpHarness({
      onDispatch: async (message) => {
        if (message.answer) {
          expect(message.text).toBe("");
          await message.answer.onReceipt({
            status: "confirmed",
            resolutionId: "native-empty-receipt",
          });
        } else {
          await message.store.requireInput(message.taskId, question);
        }
      },
    });
    await expectReply(harness.post(sendRequest({ text: "" })), rpcError(-32602));
    const initial = await harness.post(
      rpc("SendMessage", {
        message: {
          messageId: "initial-empty",
          role: "user",
          parts: [{ text: "Ask for an optional note" }],
          extensions: [U],
        },
      }),
      "alpha-secret",
      true,
    );
    const task = ((await initial.json()) as { result: { task: A2aTaskRecord } }).result.task;
    if (task.status.state !== "TASK_STATE_INPUT_REQUIRED") {
      throw new Error("Question is missing");
    }
    await expectReply(
      harness.post(
        rpc("SendMessage", {
          message: {
            taskId: task.id,
            messageId: "empty-answer",
            role: "user",
            parts: [{ text: "" }],
            extensions: [U],
            metadata: { [U]: { replyToMessageId: task.status.message.messageId } },
          },
          configuration: { returnImmediately: true },
        }),
        "alpha-secret",
        true,
      ),
      taskResult({ id: task.id, status: { state: "TASK_STATE_WORKING" } }),
    );
    expect(harness.onDispatch).toHaveBeenCalledTimes(2);
  });
}
