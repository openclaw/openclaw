import fs from "node:fs/promises";
import path from "node:path";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { afterEach, describe, expect, it } from "vitest";
import { createQaBusState } from "./bus-state.js";
import { readQaScenarioById } from "./scenario-catalog.js";
import { runLoadedScenarioFlow } from "./scenario-flow-runner.test-support.js";
import { createTempDirHarness } from "./temp-dir.test-helper.js";

const temporary = createTempDirHarness();
afterEach(() => temporary.cleanup());
const scenario = readQaScenarioById("subagent-completion-direct-fallback");
const step = scenario.execution.flow!.steps[0]!;
const guarded = step.actions.find((action) => isRecord(action) && "try" in action);
if (!isRecord(guarded) || !isRecord(guarded.try) || !Array.isArray(guarded.try.actions)) {
  throw new Error("expected guarded terminal flow actions");
}
const actions: unknown[] = guarded.try.actions;
const flow = (selected: unknown[]) => ({ steps: [{ name: step.name, actions: selected }] });

async function startPublicCase(
  acknowledgments: number,
  initialAck: "missing" | "deleted" | "foreign" = "missing",
) {
  const publicIndex = actions.findIndex((action) => isRecord(action) && "forEach" in action);
  if (publicIndex < 0) {
    throw new Error("expected public terminal cases");
  }
  const state = createQaBusState();
  const observed = createDeferred<unknown>();
  const releaseParent = createDeferred<void>();
  const parentSent = createDeferred<void>();
  const marker = "QA-SUBAGENT-TERMINAL-FALLBACK-OK";
  const run = {
    label: "qa-terminal-fallback",
    execution: { status: "terminal", outcome: { status: "ok" } },
    delivery: { status: "delivered" },
    requesterSessionKey: "parent",
    childSessionKey: "child",
    runId: "run",
  };
  const requests = [{ plannedToolName: "sessions_spawn", plannedToolArgs: { label: run.label } }];
  let parentSend: Promise<void> | undefined;
  const result = runLoadedScenarioFlow(scenario.id, {
    state,
    // Public assertions stop before the independent private/restart scenarios.
    flow: flow([
      ...step.actions.slice(0, step.actions.indexOf(guarded)),
      ...actions.slice(0, publicIndex + 1),
    ]),
    api: {
      fs,
      path,
      readNativeQaSubagentRuns: async () => [run],
      config: {
        ...scenario.execution.config,
        cases: [{ name: "fallback", marker, expectedSendCount: 1 }],
      },
      env: {
        providerMode: "mock-openai",
        outputDir: await temporary.makeTempDir("terminal-ack-"),
        mock: { baseUrl: "http://mock.invalid" },
        gateway: {
          call: async (method: string) => {
            if (method === "chat.history") {
              return {
                messages: [
                  {
                    role: "assistant",
                    provider: "openclaw",
                    model: "automation-result",
                    __openclaw: {
                      idempotencyKey: "outbound-delivery:announce:v1:child:run:text-direct:0",
                    },
                    content: [{ type: "text", text: marker }],
                  },
                ],
              };
            }
            throw new Error(`unexpected RPC ${method}`);
          },
        },
      },
      transport: {
        sendInbound: async (input: Parameters<typeof state.addInboundMessage>[0]) => {
          const message = state.addInboundMessage(input);
          const send = (text: string, conversation = input.conversation.id) =>
            state.addOutboundMessage({
              accountId: "default",
              to: `dm:${conversation}`,
              text,
            });
          send(marker);
          if (initialAck === "deleted") {
            state.deleteMessage({ accountId: "default", messageId: send("Worker started.").id });
          } else if (initialAck === "foreign") {
            send("Worker started.", "another-conversation");
          }
          parentSend = releaseParent.promise.then(() => {
            for (let i = 0; i < acknowledgments; i++) {
              send("Worker started.");
            }
            parentSent.resolve();
          });
          return message;
        },
      },
      fetchJson: async (url: string) => (url.endsWith("request-cursor") ? { cursor: 0 } : requests),
      recentOutboundSummary: () => "synthetic terminal messages",
      waitForCondition: async (
        check: () => Promise<unknown>,
        timeout: number,
        interval: number,
      ) => {
        expect([timeout, interval]).toEqual([60000, 250]);
        const early = await check();
        observed.resolve(early);
        if (early !== undefined) {
          return early;
        }
        await parentSent.promise;
        const settled = await check();
        if (settled === undefined) {
          throw new Error("terminal observation deadline: parent acknowledgment missing");
        }
        return settled;
      },
    },
  });
  // Observe failures immediately while the test coordinates the held send.
  const outcome = result.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
  return {
    observed: Promise.race([
      observed.promise,
      outcome.then((settled) => {
        if ("error" in settled) {
          throw settled.error;
        }
        throw new Error("terminal flow ended before observing child delivery");
      }),
    ]),
    outcome,
    async release() {
      releaseParent.resolve();
      await parentSend;
      await outcome;
    },
  };
}

describe("terminal completion scenario parent acknowledgment", () => {
  it.each([
    [1, "missing", undefined],
    [1, "deleted", undefined],
    [1, "foreign", undefined],
    [0, "missing", "parent acknowledgment missing"],
    [2, "missing", "spawning parent did not acknowledge"],
  ] as const)("checks %i final acknowledgments after %s", async (count, initialAck, error) => {
    const run = await startPublicCase(count, initialAck);
    try {
      expect(await run.observed).toBeUndefined();
    } finally {
      await run.release();
    }
    const outcome = await run.outcome;
    if (error) {
      expect(outcome).toHaveProperty("error");
      if ("error" in outcome) {
        expect(String(outcome.error)).toContain(error);
      }
    } else {
      expect(outcome).toMatchObject({ value: { status: "pass" } });
    }
  });
});

async function replayPrivateKickoff(text: string, fault?: string) {
  const start = actions.findIndex((action) => isRecord(action) && action.set === "privateOutbound");
  const end = actions.findIndex(
    (action, index) => index > start && isRecord(action) && "forEach" in action,
  );
  if (start < 0 || end < 0) {
    throw new Error("missing private outbound assertions");
  }
  const state = createQaBusState();
  const conversation = "terminal-private-fixture";
  const send = (
    bodyText: string,
    overrides: Partial<Parameters<typeof state.addOutboundMessage>[0]> = {},
  ) =>
    state.addOutboundMessage({
      accountId: "default",
      to: `dm:${conversation}`,
      replyToId: "ingress",
      text: bodyText,
      ...overrides,
    });
  const kickoff = send(fault === "transient" ? "private child prose" : text, {
    to: "dm:" + (fault === "target" ? "foreign" : conversation),
    attachments:
      fault === "media"
        ? [
            {
              id: "private-image",
              kind: "image",
              mimeType: "image/png",
              url: "https://example.com/private.png",
            },
          ]
        : undefined,
  });
  if (fault === "transient") {
    state.editMessage({ accountId: "default", messageId: kickoff.id, text });
  }
  send("Worker started.");
  const wire = [text, "Worker started."].map((bodyText) => ({
    type: "api",
    path: "/bot<redacted>/sendMessage",
    accepted: true,
    body: { chat_id: "123", text: bodyText },
  }));
  if (fault === "wire") {
    wire.push({
      ...wire[0]!,
      path: "/bot<redacted>/editMessageText",
      body: { chat_id: "123", text: "private child prose" },
    });
  }
  return runLoadedScenarioFlow(scenario.id, {
    state,
    flow: flow(actions.slice(start, end)),
    api: {
      privateStartIndex: 0,
      privateEventCursor: 0,
      privateWireCursor: 0,
      privateConversationId: conversation,
      privateIngress: { id: "ingress" },
      privateTelegramWire: fault !== "non-telegram",
      readTelegramWire: async () => wire,
      transport: { buildAgentDelivery: () => ({ to: "123" }) },
    },
  });
}

describe("terminal private kickoff progress oracle", () => {
  it.each([
    "<b>Working</b>",
    "<b>Working</b>\nSub-agent: running",
    "<b>Working</b>\nLast activity: Sub-agent",
  ])("accepts the public spawn status %s", async (text) => {
    await expect(replayPrivateKickoff(text)).resolves.toMatchObject({ status: "pass" });
  });

  it.each([
    "<b>Working</b>\nprivate child prose",
    "<b>Working</b>\nQA-PARENT-PRIVATE-CHILD1-0123456789ABCDEF0123456789ABCDEF",
    "<b>Working</b>\nMEDIA:qa-private-result.png",
    "<b>Working</b>\nNO_REPLY",
    "<b>Working</b>\nExec: running",
    "<b>Working</b>\nLast activity: Sub-agent\nprivate child prose",
    "<b>Working</b>\nqa-terminal-private-first: completed",
  ])("rejects non-fixture status %s", async (text) => {
    await expect(replayPrivateKickoff(text)).rejects.toThrow(
      "private completion emitted unexpected",
    );
  });

  it.each(["target", "media", "transient", "wire", "non-telegram"])(
    "does not relax the %s boundary for accepted public text",
    async (fault) => {
      await expect(
        replayPrivateKickoff("<b>Working</b>\nLast activity: Sub-agent", fault),
      ).rejects.toThrow(
        fault === "transient"
          ? "private completion leaked a transient"
          : fault === "wire"
            ? "Telegram wire capture contained private"
            : "private completion emitted unexpected",
      );
    },
  );
});
