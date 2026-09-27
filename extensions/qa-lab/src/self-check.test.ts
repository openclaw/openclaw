// Qa Lab tests cover self check plugin behavior.
import fs from "node:fs/promises";
import path from "node:path";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createQaBusState } from "./bus-state.js";
import * as registry from "./qa-transport-registry.js";
import type { QaTransportState } from "./qa-transport.js";
import { runQaScenario } from "./scenario.js";
import { createQaSelfCheckScenario } from "./self-check-scenario.js";
import type { QaSelfCheckResult } from "./self-check.js";
import {
  isQaSelfCheckSuccessful,
  resolveQaSelfCheckOutputPath,
  runQaSelfCheckAgainstState,
} from "./self-check.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

function makeSelfCheckResult(params: {
  scenarioStatus: "pass" | "fail";
  checkStatuses: Array<"pass" | "fail">;
}): QaSelfCheckResult {
  return {
    outputPath: "/tmp/qa-self-check.md",
    report: "",
    checks: params.checkStatuses.map((status, index) => ({
      name: `check ${String(index + 1)}`,
      status,
    })),
    scenarioResult: {
      name: "QA self-check scenario",
      status: params.scenarioStatus,
      steps: [],
    },
  };
}

describe("isQaSelfCheckSuccessful", () => {
  it("requires the scenario and every check to pass", () => {
    expect(
      isQaSelfCheckSuccessful(
        makeSelfCheckResult({ scenarioStatus: "pass", checkStatuses: ["pass"] }),
      ),
    ).toBe(true);
    expect(
      isQaSelfCheckSuccessful(
        makeSelfCheckResult({ scenarioStatus: "fail", checkStatuses: ["pass"] }),
      ),
    ).toBe(false);
    expect(
      isQaSelfCheckSuccessful(
        makeSelfCheckResult({ scenarioStatus: "pass", checkStatuses: ["pass", "fail"] }),
      ),
    ).toBe(false);
  });
});

describe("resolveQaSelfCheckOutputPath", () => {
  it("keeps explicit output paths untouched", () => {
    expect(
      resolveQaSelfCheckOutputPath({
        repoRoot: "/tmp/openclaw-repo",
        outputPath: "/tmp/custom/self-check.md",
      }),
    ).toBe("/tmp/custom/self-check.md");
  });

  it("anchors default self-check reports under unique files in the provided repo root", () => {
    const repoRoot = path.resolve("/tmp/openclaw-repo");
    const firstPath = resolveQaSelfCheckOutputPath({ repoRoot });
    const secondPath = resolveQaSelfCheckOutputPath({ repoRoot });

    expect(path.dirname(firstPath)).toBe(path.join(repoRoot, ".artifacts", "qa-e2e"));
    expect(path.basename(firstPath)).toMatch(/^self-check-[a-z0-9]+-[a-f0-9]{8}\.md$/u);
    expect(secondPath).not.toBe(firstPath);
  });
});

describe("createQaSelfCheckScenario", () => {
  function createSelfCheckHarness(delivery?: {
    directAccountId?: string;
    directTarget?: string;
    threadedTarget?: string;
  }) {
    const state = createQaBusState();
    const targets: unknown[] = [];
    const testState: QaTransportState = {
      ...state,
      addInboundMessage: (input: Parameters<typeof state.addInboundMessage>[0]) => {
        const inbound = state.addInboundMessage(input);
        if (input.text === "hello from qa") {
          state.addOutboundMessage({
            accountId: delivery?.directAccountId,
            to: delivery?.directTarget ?? "dm:alice",
            text: "qa-echo: hello from qa",
          });
        }
        if (input.text === "inside thread") {
          state.addOutboundMessage({
            to:
              delivery?.threadedTarget ??
              `thread:${input.conversation.id}/${String(input.threadId)}`,
            text: "qa-echo: inside thread",
          });
        }
        return inbound;
      },
    };
    const performAction = vi.fn(async (action: string, args: Record<string, unknown>) => {
      if (action === "thread-create") {
        const thread = state.createThread({
          conversationId: String(args.channelId),
          title: String(args.title),
        });
        return {
          details: {
            target: `channel:${thread.conversationId}`,
            threadId: thread.id,
            thread,
          },
        };
      }
      const message = state.readMessage({ messageId: String(args.messageId) });
      if (args.to !== `channel:${message.conversation.id}` || args.threadId !== message.threadId) {
        throw new Error("qa-channel message is not in the selected conversation");
      }
      targets.push(args.to);
      if (action === "react") {
        return state.reactToMessage({
          messageId: String(args.messageId),
          emoji: String(args.emoji),
        });
      }
      if (action === "edit") {
        return state.editMessage({
          messageId: String(args.messageId),
          text: String(args.text),
        });
      }
      if (action === "delete") {
        return state.deleteMessage({ messageId: String(args.messageId) });
      }
      throw new Error(`unexpected action: ${action}`);
    });

    return {
      state,
      testState,
      performAction,
      targets,
      run: async (signal?: AbortSignal) =>
        await runQaScenario(createQaSelfCheckScenario({ waitTimeoutMs: 20 }), {
          signal,
          state: testState,
          performAction,
        }),
    };
  }

  it("runs every roundtrip and binds lifecycle actions to the seeded message thread", async () => {
    const { state, targets, run } = createSelfCheckHarness();
    const result = await run();

    expect(result.status).toBe("pass");
    expect(result.steps.map((step) => step.name)).toEqual([
      "DM echo roundtrip",
      "Thread create and threaded echo",
      "Reaction, edit, delete lifecycle",
    ]);
    const thread = state.getSnapshot().threads[0];
    expect(thread).toBeDefined();

    expect(targets).toEqual(["channel:qa-room", "channel:qa-room", "channel:qa-room"]);
    const deletedMessage = state.getSnapshot().messages.find((message) => message.deleted);
    if (!deletedMessage) {
      throw new Error("self-check did not preserve its deleted message tombstone");
    }
    expect(state.readMessage({ messageId: deletedMessage.id }).deleted).toBe(true);
    expect(
      state.searchMessages({ query: "inside thread" }).map((message) => message.id),
    ).not.toContain(deletedMessage.id);
  });

  it.each([
    { name: "another conversation", directTarget: "dm:mallory" },
    { name: "another account", directAccountId: "foreign", directTarget: "dm:alice" },
  ])("fails the complete self-check when Alice's reply is sent to $name", async (delivery) => {
    const { state, targets, run } = createSelfCheckHarness(delivery);
    const result = await run();

    expect(
      state
        .searchMessages({ conversationId: "alice", conversationKind: "direct" })
        .filter((message) => message.direction === "outbound"),
    ).toHaveLength(0);
    expect(result.status).toBe("fail");
    expect(result.steps).toEqual([
      expect.objectContaining({ name: "DM echo roundtrip", status: "fail" }),
    ]);
    expect(targets).toHaveLength(0);
  });

  it("fails threaded delivery at its owner before running lifecycle actions", async () => {
    const { targets, run } = createSelfCheckHarness({
      threadedTarget: "thread:qa-room/unrelated-thread",
    });
    const result = await run();

    expect(result.status).toBe("fail");
    expect(result.steps.at(-1)).toEqual(
      expect.objectContaining({ name: "Thread create and threaded echo", status: "fail" }),
    );
    expect(targets).toHaveLength(0);
  });

  it.each([1, 2, 3])(
    "fences later actions after cancellation during state read %i",
    async (read) => {
      const { state, testState, performAction, run } = createSelfCheckHarness();
      const controller = new AbortController();
      const entered = createDeferred<void>();
      const release = createDeferred<void>();
      let reads = 0;
      vi.spyOn(testState, "readMessage").mockImplementation(async (input) => {
        const message = state.readMessage(input);
        if (++reads === read) {
          entered.resolve();
          await release.promise;
        }
        return message;
      });
      const pending = run(controller.signal);
      try {
        await Promise.race([
          entered.promise,
          pending.then(() => {
            throw new Error("self-check settled before the state read");
          }),
        ]);
        controller.abort(new Error("self-check cancelled"));
        release.resolve();
        expect(await pending).toMatchObject({
          status: "fail",
          details: "self-check cancelled",
        });
        expect(performAction.mock.calls.map(([action]) => action)).toEqual(
          ["thread-create", "react", "edit", "delete"].slice(0, read + 1),
        );
        expect(reads).toBe(read);
      } finally {
        controller.abort();
        release.resolve();
        await pending;
      }
    },
  );
});

describe("runQaSelfCheckAgainstState cancellation", () => {
  it.each([true, false])(
    "publishes cancellation through the real adapter (pre-aborted: %s)",
    async (preAborted) => {
      const state = createQaBusState();
      const controller = new AbortController();
      const reason = new Error("self-check cancelled");
      const entered = createDeferred<void>();
      const release = createDeferred<void>();
      const outputPath = path.join(tempDirs.make("qa-self-check-cancel-"), "report.md");
      const factory = await registry.createQaTransportAdapter({
        channelId: "qa-channel",
        driver: "qa-channel",
        outputDir: path.dirname(outputPath),
        state,
      });
      vi.spyOn(registry, "createQaTransportAdapter").mockResolvedValue(factory);
      const action = vi
        .spyOn(factory.adapter, "handleAction")
        .mockImplementation(async ({ args }) => {
          entered.resolve();
          await release.promise;
          const thread = state.createThread({
            conversationId: String(args.channelId),
            title: String(args.title),
          });
          return {
            details: {
              target: `channel:${thread.conversationId}`,
              threadId: thread.id,
              thread,
            },
          };
        });
      const addInbound = state.addInboundMessage.bind(state);
      const inbound = vi.spyOn(state, "addInboundMessage").mockImplementation((input) => {
        const message = addInbound(input);
        state.addOutboundMessage({ to: "dm:alice", text: `qa-echo: ${input.text}` });
        return message;
      });
      const reset = vi.spyOn(state, "reset");
      const cleanup = vi.spyOn(factory, "cleanupWithoutGateway");
      if (preAborted) {
        controller.abort(reason);
      }
      const run = runQaSelfCheckAgainstState({
        state,
        cfg: {},
        outputPath,
        signal: controller.signal,
      });
      void run.catch(() => undefined);
      try {
        if (!preAborted) {
          await Promise.race([
            entered.promise,
            run.then(() => {
              throw new Error("self-check settled before the action");
            }),
          ]);
          controller.abort(reason);
          expect(cleanup).not.toHaveBeenCalled();
          release.resolve();
        }
        const result = await run;
        expect(result.scenarioResult).toMatchObject({
          status: "fail",
          details: reason.message,
        });
        expect(action.mock.calls.map(([input]) => input.action)).toEqual(
          preAborted ? [] : ["thread-create"],
        );
        expect(inbound).toHaveBeenCalledTimes(preAborted ? 0 : 1);
        expect(reset).toHaveBeenCalledTimes(preAborted ? 0 : 1);
        expect(await fs.readFile(outputPath, "utf8")).toBe(result.report);
        expect(result.report).toContain(reason.message);
        expect(cleanup).toHaveBeenCalledOnce();
      } finally {
        controller.abort(reason);
        release.resolve();
        await Promise.allSettled([run]);
      }
    },
  );

  it("retains report and adapter-cleanup failures after cancellation", async () => {
    const state = createQaBusState();
    const outputPath = path.join(tempDirs.make("qa-self-check-cleanup-"), "report.md");
    const factory = await registry.createQaTransportAdapter({
      channelId: "qa-channel",
      driver: "qa-channel",
      outputDir: path.dirname(outputPath),
      state,
    });
    const reportError = new Error("report write failed");
    const cleanupError = new Error("adapter cleanup failed");
    vi.spyOn(registry, "createQaTransportAdapter").mockResolvedValue(factory);
    vi.spyOn(fs, "writeFile").mockRejectedValueOnce(reportError);
    const cleanup = vi.spyOn(factory, "cleanupWithoutGateway").mockRejectedValueOnce(cleanupError);
    await expect(
      runQaSelfCheckAgainstState({
        state,
        cfg: {},
        outputPath,
        signal: AbortSignal.abort(new Error("self-check cancelled")),
      }),
    ).rejects.toMatchObject({
      cause: reportError,
      errors: [reportError, cleanupError],
    });
    expect(cleanup).toHaveBeenCalledOnce();
  });
});
