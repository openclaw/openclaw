// Routed turns (Gateway `agent` method with a channel target) have no reply sink that
// could reserve a question prompt, so the tool surface must deliver it to that conversation.
import { afterEach, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createOpenClawTools } from "./openclaw-tools.js";

const hoisted = vi.hoisted(() => {
  let promptSent: () => void = () => {};
  return {
    sends: [] as Array<Record<string, unknown>>,
    gatewayMethods: [] as string[],
    promptIsOut: new Promise<void>((resolve) => {
      promptSent = resolve;
    }),
    promptSent: () => promptSent(),
  };
});

vi.mock("../channels/message/runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../channels/message/runtime.js")>();
  return {
    ...actual,
    sendDurableMessageBatchCore: async (params: Record<string, unknown>) => {
      hoisted.sends.push(params);
      hoisted.promptSent();
      return { status: "sent", results: [], receipt: {} };
    },
  };
});

vi.mock("./harness/gateway-question-dispatch.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./harness/gateway-question-dispatch.js")>();
  return {
    ...actual,
    resolveAgentQuestionGatewayCall:
      () => async (method: string, _options: unknown, params: Record<string, unknown>) => {
        hoisted.gatewayMethods.push(method);
        if (method === "question.request") {
          return { id: params.id };
        }
        if (method === "question.waitAnswer") {
          // Answer once the prompt reached the conversation. A tool that never publishes
          // its prompt gets a no-answer result after one event-loop turn instead of hanging.
          const sent = await Promise.race([
            hoisted.promptIsOut.then(() => true),
            new Promise<false>((resolve) => {
              setImmediate(() => resolve(false));
            }),
          ]);
          if (!sent) {
            return { status: "expired" };
          }
          return { status: "answered", answers: { answers: { target: ["Staging"] } } };
        }
        throw new Error(`unexpected question method ${method}`);
      },
  };
});

vi.mock("./openclaw-plugin-tools.js", () => ({
  resolveOpenClawPluginToolsForOptions: () => [],
}));

afterEach(() => {
  hoisted.sends.length = 0;
  hoisted.gatewayMethods.length = 0;
});

it("delivers a routed turn's blocking question to its originating conversation", async () => {
  const tools = createOpenClawTools({
    config: {} as OpenClawConfig,
    agentSessionKey: "agent:main:main",
    runId: "routed-run",
    agentChannel: "telegram",
    agentTo: "synthetic-chat",
    agentAccountId: "default",
    agentThreadId: "7",
    disablePluginTools: true,
    wrapBeforeToolCallHook: false,
  });
  const askUser = tools.find((tool) => tool.name === "ask_user");
  if (!askUser) {
    throw new Error("expected ask_user for the main session");
  }

  const result = await askUser.execute("routed-question", {
    questions: [
      {
        id: "target",
        header: "Target",
        question: "Where should this deploy?",
        options: [{ label: "Staging" }, { label: "Production" }],
      },
    ],
  });

  expect(hoisted.sends).toEqual([
    expect.objectContaining({
      channel: "telegram",
      to: "synthetic-chat",
      accountId: "default",
      threadId: "7",
      payloads: [expect.objectContaining({ text: expect.stringContaining("Where should this") })],
    }),
  ]);
  expect(hoisted.gatewayMethods).toEqual(["question.request", "question.waitAnswer"]);
  expect(result.details).toEqual({
    status: "answered",
    answers: { answers: { target: ["Staging"] } },
  });
});
