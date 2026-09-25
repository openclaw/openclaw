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

async function startPublicCase(acknowledgments: number) {
  const scenario = readQaScenarioById("subagent-completion-direct-fallback");
  const step = scenario.execution.flow!.steps[0]!;
  const guarded = step.actions.find((action) => {
    if (!isRecord(action)) {
      throw new Error("invalid terminal flow action");
    }
    return "try" in action;
  });
  if (!isRecord(guarded) || !isRecord(guarded.try) || !Array.isArray(guarded.try.actions)) {
    throw new Error("expected guarded terminal flow actions");
  }
  const actions: unknown[] = guarded.try.actions;
  const publicIndex = actions.findIndex((action) => {
    if (!isRecord(action)) {
      throw new Error("invalid guarded terminal flow action");
    }
    return "forEach" in action;
  });
  if (publicIndex < 0) {
    throw new Error("expected public terminal cases");
  }
  const state = createQaBusState();
  const observed = createDeferred<unknown>();
  const releaseParent = createDeferred<void>();
  const parentSent = createDeferred<void>();
  const marker = "QA-SUBAGENT-TERMINAL-FALLBACK-OK";
  const task = {
    taskId: "child-task",
    title: "qa-terminal-fallback",
    status: "completed",
    deliveryStatus: "delivered",
    sessionKey: "parent",
    childSessionKey: "child",
    runId: "run",
  };
  const requests = [{ plannedToolName: "sessions_spawn", plannedToolArgs: { label: task.title } }];
  let parentSend: Promise<void> | undefined;
  const result = runLoadedScenarioFlow(scenario.id, {
    state,
    // Execute the shipped public-case actions and assertions, stopping before
    // the independent private/restart scenarios rather than emulating them.
    flow: {
      steps: [
        {
          name: step.name,
          actions: [
            ...step.actions.slice(0, step.actions.indexOf(guarded)),
            ...actions.slice(0, publicIndex + 1),
          ],
        },
      ],
    },
    api: {
      fs,
      path,
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
            if (method === "tasks.list") {
              return { tasks: [task] };
            }
            if (method === "chat.history") {
              return {
                messages: [
                  {
                    role: "assistant",
                    provider: "openclaw",
                    model: "delivery-mirror",
                    __openclaw: { idempotencyKey: "announce:v1:child:run:text-direct" },
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
          const send = (text: string) =>
            state.addOutboundMessage({
              accountId: "default",
              to: `dm:${input.conversation.id}`,
              text,
            });
          send(marker);
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
  it("waits for the parent send after child delivery and its receipt settle", async () => {
    const run = await startPublicCase(1);
    try {
      expect(await run.observed).toBeUndefined();
    } finally {
      await run.release();
    }
    expect(await run.outcome).toMatchObject({ value: { status: "pass" } });
  });

  it.each([0, 2])(
    "rejects %i parent acknowledgments despite settled child delivery",
    async (count) => {
      const run = await startPublicCase(count);
      try {
        await run.observed;
      } finally {
        await run.release();
      }
      const outcome = await run.outcome;
      expect(outcome).toHaveProperty("error");
      if ("error" in outcome) {
        expect(String(outcome.error)).toContain(
          count === 0 ? "parent acknowledgment missing" : "spawning parent did not acknowledge",
        );
      }
    },
  );
});
