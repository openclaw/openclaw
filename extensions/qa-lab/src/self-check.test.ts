import { readFile } from "node:fs/promises";
import path from "node:path";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { withinTest } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, describe, expect, it, vi } from "vitest";
import { qaChannelPlugin } from "../../qa-channel/api.js";
import { startQaBusServer } from "./bus-server.js";
import { createQaBusState } from "./bus-state.js";
import * as transportRegistry from "./qa-transport-registry.js";
import * as scenarioModule from "./scenario.js";
import type { QaScenarioStepContext } from "./scenario.js";
import { createQaSelfCheckScenario } from "./self-check-scenario.js";
import { isQaSelfCheckSuccessful, runQaSelfCheckAgainstState } from "./self-check.js";
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const buses: Awaited<ReturnType<typeof startQaBusServer>>[] = [];
afterEach(async () => {
  for (const bus of buses.splice(0)) {
    await bus.stop();
  }
});
afterEach(() => vi.restoreAllMocks());

describe("QA self-check", () => {
  it.each([
    ["pass", ["pass"], true],
    ["fail", ["pass"], false],
    ["pass", ["pass", "fail"], false],
  ] as const)("requires passing scenario=%s and checks=%j", (status, checks, success) => {
    expect(
      isQaSelfCheckSuccessful({
        outputPath: "/tmp/qa-self-check.md",
        report: "",
        checks: checks.map((checkStatus) => ({ name: "check", status: checkStatus })),
        scenarioResult: { name: "QA self-check scenario", status, steps: [] },
      }),
    ).toBe(success);
  });
  it("writes unique default reports under the repo root and honors an explicit output path", async () => {
    vi.spyOn(scenarioModule, "runQaScenario").mockResolvedValue({
      name: "Artifact report fixture",
      status: "pass",
      steps: [],
    });
    const repoRoot = tempDirs.make("qa-self-check-reports-");
    const params = { state: createQaBusState(), cfg: {}, repoRoot };
    const first = await runQaSelfCheckAgainstState(params);
    const second = await runQaSelfCheckAgainstState(params);
    const outputPath = path.join(repoRoot, "custom", "self-check.md");
    const explicit = await runQaSelfCheckAgainstState({ ...params, outputPath });

    for (const result of [first, second]) {
      expect(path.dirname(result.outputPath)).toBe(path.join(repoRoot, ".artifacts", "qa-e2e"));
      expect(path.basename(result.outputPath)).toMatch(/^self-check-[a-z0-9]+-[a-f0-9]{8}\.md$/u);
    }
    expect(second.outputPath).not.toBe(first.outputPath);
    expect(explicit.outputPath).toBe(outputPath);
    for (const result of [first, second, explicit]) {
      expect(result.report).toContain("# OpenClaw QA E2E Self-Check");
      expect(result.report).toContain("### Artifact report fixture");
      expect(await readFile(result.outputPath, "utf8")).toBe(result.report);
    }
  });
  async function createSelfCheckHarness(delivery?: {
    directAccountId?: string;
    directTarget?: string;
    threadedTarget?: string;
  }) {
    const state = createQaBusState();
    const bus = await startQaBusServer({ state });
    buses.push(bus);
    const targets: unknown[] = [];
    const testState = {
      ...state,
      addInboundMessage: (input: Parameters<typeof state.addInboundMessage>[0]) => {
        const inbound = state.addInboundMessage(input);
        const direct = input.text === "hello from qa";
        if (direct || input.text === "inside thread") {
          state.addOutboundMessage({
            accountId: direct ? delivery?.directAccountId : undefined,
            to: direct
              ? (delivery?.directTarget ?? "dm:alice")
              : (delivery?.threadedTarget ?? `thread:${input.conversation.id}/${input.threadId}`),
            text: `qa-echo: ${input.text}`,
          });
        }
        return inbound;
      },
    };
    const handleAction = qaChannelPlugin.actions?.handleAction;
    if (!handleAction) {
      throw new Error("expected QA channel action handler");
    }
    const performAction: NonNullable<QaScenarioStepContext["performAction"]> = (action, args) => {
      if (action !== "thread-create") {
        targets.push(args.to);
      }
      return handleAction({
        channel: "qa-channel",
        action,
        cfg: { channels: { "qa-channel": { baseUrl: bus.baseUrl } } },
        accountId: "default",
        params: args,
      });
    };

    return {
      state: testState,
      targets,
      performAction,
      run: async () =>
        await scenarioModule.runQaScenario(createQaSelfCheckScenario({ waitTimeoutMs: 20 }), {
          state: testState,
          performAction,
        }),
    };
  }

  it("joins acquired transport cleanup when writing the self-check report fails", async ({
    signal,
  }) => {
    const { state, performAction } = await createSelfCheckHarness();
    const outputPath = tempDirs.make("qa-self-check-write-failure-");
    const cleanupEntered = Promise.withResolvers<void>();
    const releaseCleanup = Promise.withResolvers<void>();
    const createTransport = transportRegistry.createQaTransportAdapter;
    using _ = vi
      .spyOn(transportRegistry, "createQaTransportAdapter")
      .mockImplementation(async (context) => {
        const acquired = await createTransport(context);
        return {
          ...acquired,
          adapter: {
            ...acquired.adapter,
            handleAction: ({ action, args }) => performAction(action, args),
          },
          async cleanupWithoutGateway() {
            cleanupEntered.resolve();
            await releaseCleanup.promise;
            await acquired.cleanupWithoutGateway();
          },
        };
      });
    let settled = false;
    const run = runQaSelfCheckAgainstState({ state, cfg: {}, outputPath }).finally(() => {
      settled = true;
    });
    const failed = run.then(
      () => "resolved",
      (error: unknown) => {
        expect(error).toMatchObject({ path: outputPath });
        return "rejected";
      },
    );
    try {
      const phase = await withinTest(
        Promise.race([cleanupEntered.promise.then(() => "cleanup"), failed]),
        signal,
      );
      expect({ phase, settled }).toEqual({ phase: "cleanup", settled: false });
      releaseCleanup.resolve();
      await expect(withinTest(failed, signal)).resolves.toBe("rejected");
    } finally {
      releaseCleanup.resolve();
      await Promise.allSettled([run, failed]);
    }
  });

  it("runs every roundtrip and binds lifecycle actions to the seeded message thread", async () => {
    const { targets, run } = await createSelfCheckHarness();
    const result = await run();

    expect(result.status).toBe("pass");
    expect(result.steps.map((step) => step.name)).toEqual([
      "DM echo roundtrip",
      "Thread create and threaded echo",
      "Reaction, edit, delete lifecycle",
    ]);
    expect(targets).toEqual(["channel:qa-room", "channel:qa-room", "channel:qa-room"]);
  });

  it.each([
    { name: "another conversation", directTarget: "dm:mallory" },
    { name: "another account", directAccountId: "foreign", directTarget: "dm:alice" },
    { name: "another thread", threadedTarget: "thread:qa-room/unrelated-thread" },
  ])("stops before lifecycle actions when the reply goes to $name", async (delivery) => {
    const { state, targets, run } = await createSelfCheckHarness(delivery);
    const result = await run();
    expect(result.status).toBe("fail");
    expect(result.steps.at(-1)).toMatchObject({
      name: delivery.threadedTarget ? "Thread create and threaded echo" : "DM echo roundtrip",
      status: "fail",
    });
    if (!delivery.threadedTarget) {
      expect(result.steps).toHaveLength(1);
      expect(
        state
          .searchMessages({ conversationId: "alice", conversationKind: "direct" })
          .filter((message) => message.direction === "outbound"),
      ).toHaveLength(0);
    }
    expect(targets).toHaveLength(0);
  });
});
