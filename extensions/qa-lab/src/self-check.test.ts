import { readFile } from "node:fs/promises";
import path from "node:path";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { withinTest } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, expect, it, vi } from "vitest";
import { qaChannelPlugin } from "../../qa-channel/api.js";
import { startQaBusServer } from "./bus-server.js";
import { createQaBusState } from "./bus-state.js";
import * as transportRegistry from "./qa-transport-registry.js";
import { isQaSelfCheckSuccessful, runQaSelfCheckAgainstState } from "./self-check.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const buses: Awaited<ReturnType<typeof startQaBusServer>>[] = [];
afterEach(async () => {
  for (const bus of buses.splice(0)) {
    await bus.stop();
  }
});
afterEach(() => vi.restoreAllMocks());

async function createSelfCheckHarness(
  delivery?: { directAccountId?: string; directTarget?: string; threadedTarget?: string },
  beforeCleanup?: () => Promise<void>,
) {
  const state = createQaBusState();
  const bus = await startQaBusServer({ state });
  buses.push(bus);
  const targets: unknown[] = [];
  const addInbound = state.addInboundMessage.bind(state);
  vi.spyOn(state, "addInboundMessage").mockImplementation((input) => {
    const inbound = addInbound(input);
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
  });
  const handleAction = qaChannelPlugin.actions?.handleAction;
  if (!handleAction) {
    throw new Error("expected QA channel action handler");
  }
  const createTransport = transportRegistry.createQaTransportAdapter;
  vi.spyOn(transportRegistry, "createQaTransportAdapter").mockImplementation(async (context) => {
    const acquired = await createTransport(context);
    const cleanup = acquired.cleanupWithoutGateway;
    acquired.adapter.handleAction = ({ action, args }) => {
      if (action !== "thread-create") {
        targets.push(args.to);
      }
      return handleAction({
        channel: "qa-channel",
        action,
        params: args,
        accountId: "default",
        cfg: { channels: { "qa-channel": { baseUrl: bus.baseUrl } } },
      });
    };
    acquired.cleanupWithoutGateway = async () => {
      await beforeCleanup?.();
      await cleanup();
    };
    return acquired;
  });
  const repoRoot = tempDirs.make("qa-self-check-");
  const run = (options: { outputPath?: string } = {}) =>
    runQaSelfCheckAgainstState({ state, cfg: {}, repoRoot, waitTimeoutMs: 20, ...options });
  return { state, targets, repoRoot, run };
}

it.each([
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

it("runs target-bound roundtrips and writes unique default or explicit reports", async () => {
  const { run, repoRoot, targets } = await createSelfCheckHarness();
  const first = await run();
  expect(isQaSelfCheckSuccessful(first)).toBe(true);
  expect(targets).toEqual(["channel:qa-room", "channel:qa-room", "channel:qa-room"]);
  const second = await run();
  const outputPath = path.join(repoRoot, "custom", "self-check.md");
  const explicit = await run({ outputPath });
  for (const result of [first, second]) {
    expect(path.dirname(result.outputPath)).toBe(path.join(repoRoot, ".artifacts", "qa-e2e"));
  }
  expect(second.outputPath).not.toBe(first.outputPath);
  expect(explicit.outputPath).toBe(outputPath);
  for (const result of [first, second, explicit]) {
    expect(result.report).toContain("# OpenClaw QA E2E Self-Check");
    expect(result.report).toContain("### Synthetic Slack-class roundtrip");
    expect(await readFile(result.outputPath, "utf8")).toBe(result.report);
  }
});

it("joins transport cleanup after a report write failure", async ({ signal }) => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const { run } = await createSelfCheckHarness(undefined, async () => {
    entered.resolve();
    await release.promise;
  });
  const outputPath = tempDirs.make("qa-self-check-write-failure-");
  let settled = false;
  const pending = run({ outputPath })
    .catch((error: unknown) => error)
    .finally(() => {
      settled = true;
    });
  try {
    const phase = await withinTest(
      Promise.race([entered.promise.then(() => "cleanup"), pending]),
      signal,
    );
    expect({ phase, settled }).toEqual({ phase: "cleanup", settled: false });
    release.resolve();
    expect(await withinTest(pending, signal)).toMatchObject({ path: outputPath });
  } finally {
    release.resolve();
    await Promise.allSettled([pending]);
  }
});

it.each([
  { name: "another conversation", directTarget: "dm:mallory" },
  { name: "another account", directAccountId: "foreign", directTarget: "dm:alice" },
  { name: "another thread", threadedTarget: "thread:qa-room/unrelated-thread" },
])("stops before lifecycle actions when the reply goes to $name", async (delivery) => {
  const { state, targets, run } = await createSelfCheckHarness(delivery);
  const { scenarioResult: result } = await run();
  expect(result.status).toBe("fail");
  expect(result.steps.at(-1)).toMatchObject({
    name: delivery.threadedTarget ? "Thread create and threaded echo" : "DM echo roundtrip",
    status: "fail",
  });
  if (!delivery.threadedTarget) {
    expect(result.steps).toHaveLength(1);
    const messages = state.searchMessages({
      conversationId: "alice",
      conversationKind: "direct",
    });
    expect(messages.filter((message) => message.direction === "outbound")).toHaveLength(0);
  }
  expect(targets).toHaveLength(0);
});
