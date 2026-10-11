import { describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import { composeSessionSourceAssertion } from "../../config/sessions/session-source-authority.js";
import { resolveSessionTranscriptReadFence } from "../../config/sessions/session-transcript-read-fence.js";
import { prepareSystemAgentRunAdmission } from "../admitted-run-context.js";
import {
  assembleHarnessContextEngine,
  bootstrapHarnessContextEngine,
  prepareHarnessContextEnginePrompt,
} from "./context-engine-lifecycle.js";
import {
  createContextEngine,
  sessionParams,
  textMessage,
} from "./context-engine-lifecycle.test-support.js";

describe("harness context engine source scopes", () => {
  it.each(
    (["prepared", "admitted"] as const).flatMap((phase) =>
      (["before", "consumer"] as const).flatMap((closedAt) =>
        (["scoped", "plain", "absent"] as const).map((sourceKind) => ({
          phase,
          closedAt,
          sourceKind,
        })),
      ),
    ),
  )(
    "refuses $phase $sourceKind work when admission closes at $closedAt",
    async ({ phase, closedAt, sourceKind }) => {
      const release = vi.fn();
      const open = vi.fn(async () => ({ checks: [], assertCurrent: () => {}, release }));
      const source = vi.fn();
      const prepared = prepareSystemAgentRunAdmission(
        {},
        `close-${phase}-${closedAt}-${sourceKind}`,
        "main",
        "test",
        sourceKind === "scoped"
          ? Object.assign(source, { prepareSessionSourceScope: open })
          : sourceKind === "plain"
            ? source
            : undefined,
      );
      const authority =
        phase === "prepared"
          ? { preparedRunAdmission: prepared }
          : { admittedRunContext: await prepared.admit("embedded") };
      source.mockClear();
      const consumerStarted = createDeferred();
      const finishConsumer = createDeferred();
      if (closedAt === "before") {
        prepared.close();
      }
      const run = assembleHarnessContextEngine({
        ...sessionParams,
        ...authority,
        contextEngine: createContextEngine({
          assemble: async ({ messages }) => {
            prepared.assertSourceCurrent();
            consumerStarted.resolve();
            await finishConsumer.promise;
            return { messages, estimatedTokens: 0 };
          },
        }),
        messages: [],
        modelId: "test-model",
      });
      const rejected = expect(run).rejects.toThrow(/closed|no longer active/);
      try {
        if (closedAt === "consumer") {
          await awaitGateBeforeSettlement(
            consumerStarted.promise,
            run,
            "source consumer was skipped",
          );
          prepared.close();
          finishConsumer.resolve();
        }
        await rejected;
        const scopedConsumer = closedAt === "consumer" && sourceKind === "scoped";
        expect(open).toHaveBeenCalledTimes(scopedConsumer ? 1 : 0);
        expect(release).toHaveBeenCalledTimes(scopedConsumer ? 1 : 0);
        expect(source).toHaveBeenCalledTimes(
          closedAt === "consumer" && sourceKind === "plain" ? 1 : 0,
        );
        expect(() => prepared.assertSourceCurrent()).not.toThrow();
      } finally {
        finishConsumer.resolve();
        await run.catch(() => {});
        prepared.close();
      }
    },
  );

  it("refuses an unrecognized admitted carrier without replacing the canonical source", async () => {
    const release = vi.fn();
    const open = vi.fn(async () => ({ checks: [], assertCurrent: () => {}, release }));
    const prepared = prepareSystemAgentRunAdmission(
      {},
      "unrecognized-source-context",
      "main",
      "test",
      Object.assign(() => {}, { prepareSessionSourceScope: open }),
    );
    const admitted = await prepared.admit("embedded");
    const assemble = (admittedRunContext: typeof admitted) =>
      assembleHarnessContextEngine({
        ...sessionParams,
        admittedRunContext,
        contextEngine: createContextEngine(),
        messages: [],
        modelId: "test-model",
      });
    try {
      await expect(assemble({ ...admitted })).rejects.toThrow("no longer active");
      expect(open).not.toHaveBeenCalled();
      await expect(assemble(admitted)).resolves.toMatchObject({ messages: [] });
      expect(open).toHaveBeenCalledOnce();
      expect(release).toHaveBeenCalledOnce();
    } finally {
      prepared.close();
    }
  });

  it.each(
    (["bootstrap", "assemble", "prompt"] as const).flatMap((operation) =>
      (["prepare", "assert", "consumer", "release"] as const).map((phase) => ({
        operation,
        phase,
      })),
    ),
  )(
    "refuses $operation when source authority fails during $phase",
    async ({ operation, phase }) => {
      const failure = new Error(`source authority failed during ${phase}`);
      let revoked = false;
      const release = vi.fn(async () => {
        if (phase === "release") {
          throw failure;
        }
      });
      const open = vi.fn(async () => {
        if (phase === "prepare") {
          throw failure;
        }
        return {
          checks: [],
          assertCurrent: () => {
            if (phase === "assert" || revoked) {
              throw failure;
            }
          },
          release,
        };
      });
      const source = Object.assign(() => {}, { prepareSessionSourceScope: open });
      const prepared = prepareSystemAgentRunAdmission(
        {},
        `failure-${operation}-${phase}`,
        "main",
        "test",
        source,
      );
      const consume = async () => {
        if (phase === "consumer") {
          revoked = true;
        }
      };
      const warn = vi.fn();
      const params = {
        ...sessionParams,
        preparedRunAdmission: prepared,
        contextEngine: createContextEngine({
          bootstrap: async () => {
            await consume();
            return { bootstrapped: true };
          },
          assemble: async ({ messages }) => {
            await consume();
            return { messages, estimatedTokens: 0 };
          },
        }),
        messages: [],
        modelId: "test-model",
        promptBudget: { reserveTokens: 0, systemPrompt: "system", prompt: "user" },
        repairToolUseResultPairing: false,
        isOpenAIResponsesApi: false,
        warn,
      };
      try {
        const run =
          operation === "bootstrap"
            ? bootstrapHarnessContextEngine({
                ...params,
                hadSessionFile: true,
                runMaintenance: async () => undefined,
              })
            : operation === "assemble"
              ? assembleHarnessContextEngine(params)
              : prepareHarnessContextEnginePrompt(params);
        await expect(run).rejects.toThrow("source authority failed");
        expect(open).toHaveBeenCalledOnce();
        expect(release).toHaveBeenCalledTimes(phase === "prepare" ? 0 : 1);
        expect(warn).not.toHaveBeenCalled();
      } finally {
        prepared.close();
      }
    },
  );

  it.each(["bootstrap", "prompt"] as const)(
    "preserves %s plugin fallback inside one retained source scope",
    async (operation) => {
      const failure = new Error("plugin failed");
      const release = vi.fn();
      const open = vi.fn(async () => ({ checks: [], assertCurrent: () => {}, release }));
      const prepared = prepareSystemAgentRunAdmission(
        {},
        `plugin-${operation}`,
        "main",
        "test",
        Object.assign(() => {}, { prepareSessionSourceScope: open }),
      );
      const warn = vi.fn();
      const messages = [textMessage("user", "keep me", 1)];
      const fail = async (): Promise<never> => {
        throw failure;
      };
      const params = {
        ...sessionParams,
        preparedRunAdmission: prepared,
        contextEngine: createContextEngine({ bootstrap: fail, assemble: fail }),
        messages,
        modelId: "test-model",
        promptBudget: { reserveTokens: 0, systemPrompt: "system", prompt: "user" },
        repairToolUseResultPairing: false,
        isOpenAIResponsesApi: false,
        warn,
      };
      try {
        if (operation === "bootstrap") {
          await expect(
            bootstrapHarnessContextEngine({ ...params, hadSessionFile: true }),
          ).resolves.toBeUndefined();
        } else {
          await expect(prepareHarnessContextEnginePrompt(params)).resolves.toMatchObject({
            messages,
            systemPrompt: "system",
          });
        }
        expect(warn).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("plugin failed"));
        expect(open).toHaveBeenCalledOnce();
        expect(release).toHaveBeenCalledOnce();
      } finally {
        prepared.close();
      }
    },
  );

  it.each(["bootstrap", "assemble"] as const)(
    "retains prepared source authority through asynchronous %s consumers and release",
    async (operation) => {
      const admission = {
        agentId: "main",
        sessionId: sessionParams.sessionId,
        sessionKey: sessionParams.sessionKey,
        storePath: "/tmp/context-engine-source/openclaw-agent.sqlite",
        generation: "generation-1",
        entryId: "current-user",
        rawSeq: 1,
        effectiveParentId: null,
        activeMessagePosition: 0,
        logicalTurnId: "current-turn",
        role: "user" as const,
      };
      const consumerStarted = createDeferred();
      const finishConsumer = createDeferred();
      const releaseStarted = createDeferred();
      const finishRelease = createDeferred();
      const events: string[] = [];
      const source = composeSessionSourceAssertion([
        Object.assign(
          () => {
            throw new Error("this source requires a prepared scope");
          },
          {
            prepareSessionSourceScope: async () => {
              expect(resolveSessionTranscriptReadFence(admission)).toBe(admission);
              events.push("open");
              return {
                checks: [],
                assertCurrent: () => {
                  expect(events).not.toContain("release");
                },
                release: async () => {
                  events.push("release");
                  releaseStarted.resolve();
                  await finishRelease.promise;
                  events.push("released");
                },
              };
            },
          },
        ),
      ]);
      const prepared = prepareSystemAgentRunAdmission(
        {},
        `scope-${operation}`,
        "main",
        "test",
        source,
      );
      const consume = async () => {
        prepared.assertSourceCurrent();
        consumerStarted.resolve();
        await finishConsumer.promise;
        prepared.assertSourceCurrent();
        events.push("consumed");
      };
      const params = {
        ...sessionParams,
        preparedRunAdmission: prepared,
        transcriptReadFence: admission,
      };
      const run =
        operation === "bootstrap"
          ? bootstrapHarnessContextEngine({
              ...params,
              hadSessionFile: true,
              contextEngine: createContextEngine({
                bootstrap: async () => ({ bootstrapped: true }),
              }),
              runMaintenance: async () => {
                await consume();
                return undefined;
              },
              warn: (message) => {
                throw new Error(message);
              },
            })
          : assembleHarnessContextEngine({
              ...params,
              contextEngine: createContextEngine({
                assemble: async ({ messages }) => {
                  await consume();
                  return { messages, estimatedTokens: 0 };
                },
              }),
              messages: [],
              modelId: "test-model",
            });
      try {
        await awaitGateBeforeSettlement(
          consumerStarted.promise,
          run,
          "source consumer was skipped",
        );
        expect(events).toEqual(["open"]);
        finishConsumer.resolve();
        await awaitGateBeforeSettlement(releaseStarted.promise, run, "source release was skipped");
        expect(events).toEqual(["open", "consumed", "release"]);
        finishRelease.resolve();
        await run;
        expect(events).toEqual(["open", "consumed", "release", "released"]);
      } finally {
        finishConsumer.resolve();
        finishRelease.resolve();
        await run.catch(() => {});
        prepared.close();
      }
    },
  );
});
