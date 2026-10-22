import assert from "node:assert/strict";
import type { AgentHarnessQuestionGatewayCall } from "openclaw/plugin-sdk/agent-harness-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { isJsonObject } from "./protocol.js";

export function createUserInputGateway(
  waitAnswer?: (id: string) => unknown,
  cancel?: (id: string) => void,
) {
  const calls: Array<{ method: string; opts: unknown; params: unknown }> = [];
  const questions: Array<{ id: string; questions: unknown[] }> = [];
  const wait = createDeferred<unknown>();
  const call: AgentHarnessQuestionGatewayCall = async (method, opts, params) => {
    calls.push({ method, opts, params });
    assert(isJsonObject(params));
    if (method === "question.request" || method === "question.waitAnswer") {
      assert(typeof params.id === "string");
      if (method === "question.waitAnswer") {
        return await (waitAnswer ? waitAnswer(params.id) : wait.promise);
      }
      assert(Array.isArray(params.questions));
      questions.push({ id: params.id, questions: params.questions });
      return { id: params.id, ...(waitAnswer ? {} : { expiresAtMs: Date.now() + 90_000 }) };
    }
    if (method === "question.resolve") {
      if (cancel) {
        assert(typeof params.id === "string");
        cancel(params.id);
        return { status: "cancelled" };
      }
      const result = params.cancel
        ? { status: "cancelled" as const }
        : { status: "answered" as const, answers: params.answers };
      wait.resolve(result);
      return result;
    }
    throw new Error(`unexpected gateway method: ${method}`);
  };
  return { call, calls, questions };
}
