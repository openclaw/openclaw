import { describe, expect, it, onTestFinished, vi } from "vitest";
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

const assemblyParams = {
  ...sessionParams,
  messages: [],
  modelId: "test-model",
};
const promptParams = {
  ...assemblyParams,
  promptBudget: { reserveTokens: 0, systemPrompt: "system", prompt: "user" },
  repairToolUseResultPairing: false,
  isOpenAIResponsesApi: false,
};
function prepareSource(id: string, source?: Parameters<typeof prepareSystemAgentRunAdmission>[4]) {
  const prepared = prepareSystemAgentRunAdmission({}, id, "main", "test", source);
  onTestFinished(() => prepared.close());
  return prepared;
}
function sourceScope(
  hooks: {
    prepare?: () => void;
    assertCurrent?: () => void;
    release?: () => void | Promise<void>;
    unscoped?: () => void;
  } = {},
) {
  const release = vi.fn(hooks.release ?? (() => {}));
  const open = vi.fn(async () => {
    hooks.prepare?.();
    return { checks: [], assertCurrent: hooks.assertCurrent ?? (() => {}), release };
  });
  return {
    open,
    release,
    source: Object.assign(vi.fn(hooks.unscoped), { prepareSessionSourceScope: open }),
  };
}
function runEngine(
  operation: "bootstrap" | "assemble" | "prompt",
  params: Parameters<typeof prepareHarnessContextEnginePrompt>[0] &
    Pick<Parameters<typeof bootstrapHarnessContextEngine>[0], "runMaintenance">,
) {
  return operation === "bootstrap"
    ? bootstrapHarnessContextEngine({ ...params, hadSessionFile: true })
    : operation === "assemble"
      ? assembleHarnessContextEngine(params)
      : prepareHarnessContextEnginePrompt(params);
}

describe("harness context engine source scopes", () => {
  it.each(
    (["prepared", "admitted"] as const).flatMap((phase) =>
      (["scoped", "plain", "absent"] as const).map((sourceKind) => ({ phase, sourceKind })),
    ),
  )(
    "refuses $phase $sourceKind work when admission is already closed",
    async ({ phase, sourceKind }) => {
      const { release, open } = sourceScope();
      const source = vi.fn();
      const prepared = prepareSource(
        `close-${phase}-${sourceKind}`,
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
      open.mockClear();
      release.mockClear();
      prepared.close();
      const run = assembleHarnessContextEngine({
        ...assemblyParams,
        ...authority,
        contextEngine: createContextEngine({
          assemble: async ({ messages }) => {
            prepared.assertSourceCurrent();
            return { messages, estimatedTokens: 0 };
          },
        }),
      });
      await expect(run).rejects.toThrow(/closed|no longer active/);
      expect(open).not.toHaveBeenCalled();
      expect(release).not.toHaveBeenCalled();
      expect(source).not.toHaveBeenCalled();
      expect(() => prepared.assertSourceCurrent()).not.toThrow();
    },
  );

  it("refuses an unrecognized admitted carrier without replacing the canonical source", async () => {
    const { release, open, source } = sourceScope();
    const prepared = prepareSource("unrecognized-source-context", source);
    const admitted = await prepared.admit("embedded");
    open.mockClear();
    release.mockClear();
    const assemble = (admittedRunContext: typeof admitted) =>
      assembleHarnessContextEngine({
        ...assemblyParams,
        admittedRunContext,
        contextEngine: createContextEngine(),
      });
    await expect(assemble({ ...admitted })).rejects.toThrow("no longer active");
    expect(open).not.toHaveBeenCalled();
    await expect(assemble(admitted)).resolves.toMatchObject({ messages: [] });
    expect(open).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
  });

  it.each(
    (["bootstrap", "assemble", "prompt"] as const).flatMap((operation) =>
      (["prepare", "assert", "release"] as const).map((phase) => ({
        operation,
        phase,
      })),
    ),
  )(
    "refuses $operation when source authority fails during $phase",
    async ({ operation, phase }) => {
      const failure = new Error(`source authority failed during ${phase}`);
      const failAt = (boundary: typeof phase) => () => {
        if (phase === boundary) {
          throw failure;
        }
      };
      const { release, open, source } = sourceScope({
        prepare: failAt("prepare"),
        assertCurrent: failAt("assert"),
        release: async () => failAt("release")(),
      });
      const prepared = prepareSource(`failure-${operation}-${phase}`, source);
      const warn = vi.fn();
      const params = {
        ...promptParams,
        preparedRunAdmission: prepared,
        contextEngine: createContextEngine({
          bootstrap: async () => ({ bootstrapped: true }),
        }),
        runMaintenance: async () => undefined,
        warn,
      };
      await expect(runEngine(operation, params)).rejects.toThrow("source authority failed");
      expect(open).toHaveBeenCalledOnce();
      expect(release).toHaveBeenCalledTimes(phase === "prepare" ? 0 : 1);
      expect(warn).not.toHaveBeenCalled();
    },
  );

  it.each(["bootstrap", "prompt"] as const)(
    "preserves %s plugin fallback inside one retained source scope",
    async (operation) => {
      const failure = new Error("plugin failed");
      const { release, open, source } = sourceScope();
      const prepared = prepareSource(`plugin-${operation}`, source);
      const warn = vi.fn();
      const messages = [textMessage("user", "keep me", 1)];
      const fail = async (): Promise<never> => {
        throw failure;
      };
      const params = {
        ...promptParams,
        preparedRunAdmission: prepared,
        contextEngine: createContextEngine({ bootstrap: fail, assemble: fail }),
        messages,
        warn,
      };
      if (operation === "bootstrap") {
        await expect(runEngine(operation, params)).resolves.toBeUndefined();
      } else {
        await expect(runEngine(operation, params)).resolves.toMatchObject({
          messages,
          systemPrompt: "system",
        });
      }
      expect(warn).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("plugin failed"));
      expect(open).toHaveBeenCalledOnce();
      expect(release).toHaveBeenCalledOnce();
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
      const { source } = sourceScope({
        unscoped: () => {
          throw new Error("this source requires a prepared scope");
        },
        prepare: () => {
          expect(resolveSessionTranscriptReadFence(admission)).toBe(admission);
          events.push("open");
        },
        assertCurrent: () => {
          expect(events).not.toContain("release");
        },
        release: async () => {
          events.push("release");
          releaseStarted.resolve();
          await finishRelease.promise;
          events.push("released");
        },
      });
      const prepared = prepareSource(`scope-${operation}`, composeSessionSourceAssertion([source]));
      const consume = async () => {
        prepared.assertSourceCurrent();
        consumerStarted.resolve();
        await finishConsumer.promise;
        prepared.assertSourceCurrent();
        events.push("consumed");
      };
      const params = {
        ...promptParams,
        preparedRunAdmission: prepared,
        transcriptReadFence: admission,
        contextEngine: createContextEngine({
          bootstrap: async () => ({ bootstrapped: true }),
          assemble: async ({ messages }) => {
            await consume();
            return { messages, estimatedTokens: 0 };
          },
        }),
        runMaintenance: async () => {
          await consume();
          return undefined;
        },
        warn: (message: string) => {
          throw new Error(message);
        },
      };
      const run = runEngine(operation, params);
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
      }
    },
  );
});
