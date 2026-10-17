import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { afterEach, expect, it } from "vitest";
import { startQaBusServer } from "./bus-server.js";
import { createQaBusState } from "./bus-state.js";
import { createQaGatewayChild } from "./gateway-child.js";
import { QA_SUBAGENT_SELF_YIELD_MARKER } from "./providers/mock-openai/mock-openai-contracts.js";
import { startQaMockOpenAiServer } from "./providers/mock-openai/server.js";
import { createQaChannelTransport } from "./qa-channel-transport.js";

const PLUGIN_ID = "qa-self-yield-followup-subagent";
const TRIGGER = "qa self yield follow-up";
const REQUESTER_CONVERSATION = { id: "requester-user", kind: "direct" as const };
const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const PLUGIN_DIR = path.join(
  REPO_ROOT,
  "extensions/qa-lab/test-fixtures/self-yield-followup-subagent-plugin",
);
const VERDICT_PATH = path.join(
  REPO_ROOT,
  ".artifacts/qa-e2e/handoff-adoption/channel-handoff-verdict.json",
);

function withFixturePlugin(config: OpenClawConfig): OpenClawConfig {
  return {
    ...config,
    plugins: {
      ...config.plugins,
      enabled: true,
      allow: [...new Set([...(config.plugins?.allow ?? []), PLUGIN_ID])],
      load: {
        ...config.plugins?.load,
        paths: [...new Set([...(config.plugins?.load?.paths ?? []), PLUGIN_DIR])],
      },
      entries: {
        ...config.plugins?.entries,
        [PLUGIN_ID]: { enabled: true },
      },
    },
  };
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) {
    await cleanup();
  }
});

it("announces to the original requester only after the follow-up run ends", async () => {
  const state = createQaBusState();
  const transport = createQaChannelTransport(state);
  const bus = await startQaBusServer({ state });
  cleanups.push(() => bus.stop());
  const mock = await startQaMockOpenAiServer();
  cleanups.push(() => mock.stop());
  const owner = createQaGatewayChild();
  cleanups.push(async () => {
    expect((await owner.stop()).errors).toEqual([]);
  });
  const gateway = await owner.start({
    repoRoot: REPO_ROOT,
    providerBaseUrl: `${mock.baseUrl}/v1`,
    mockSessionObserverUrl: mock.sessionObserverUrl,
    providerMode: "mock-openai",
    transport,
    transportBaseUrl: bus.baseUrl,
    controlUiEnabled: false,
    mutateConfig: withFixturePlugin,
    // E2E prerequisites own the build; keep the packaged plugin/auth path.
    command: {
      executablePath: process.execPath,
      argsPrefix: [path.join(REPO_ROOT, "dist/index.js")],
      cwd: REPO_ROOT,
      usePackagedPlugins: true,
    },
  });
  await transport.waitReady({ gateway });

  const outboundMessages = () =>
    state.getSnapshot().messages.filter((message) => message.direction === "outbound");
  const completionCount = () =>
    outboundMessages().filter((message) => message.text.includes(QA_SUBAGENT_SELF_YIELD_MARKER))
      .length;
  const outboundStartIndex = outboundMessages().length;
  const waitForReply = (textIncludes: string, timeoutMs: number) =>
    transport.waitForOutbound({
      conversation: REQUESTER_CONVERSATION,
      sinceIndex: outboundStartIndex,
      textIncludes,
      timeoutMs,
    });
  const post = async (route: string, expectedStatus: number) => {
    const response = await fetch(`${gateway.baseUrl}/qa/self-yield/${route}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${gateway.token}`,
        ...(route === "follow-up" ? { "Content-Type": "application/json" } : {}),
      },
      ...(route === "follow-up" ? { body: JSON.stringify({}) } : {}),
    });
    expect(response.status).toBe(expectedStatus);
    return response.json();
  };
  await transport.sendInbound({
    accountId: "default",
    conversation: REQUESTER_CONVERSATION,
    senderId: REQUESTER_CONVERSATION.id,
    text: TRIGGER,
  });

  let distinctFollowupRun: boolean;

  try {
    // The kickoff reply only acknowledges the spawn; it carries no child result.
    await waitForReply("QA-SELF-YIELD-SPAWNED", 30_000);
    const followUp = (await post("follow-up", 202)) as {
      runId: string;
    };
    expect(followUp.runId).toBeTruthy();
    const release = (await post("release", 200)) as {
      finalReply?: string;
      kickoffRunId?: string;
      runId?: string;
      status?: string;
    };
    expect(release).toMatchObject({
      finalReply: QA_SUBAGENT_SELF_YIELD_MARKER,
      status: "ok",
      runId: followUp.runId,
    });
    expect(release.kickoffRunId).toBeTruthy();
    expect(release.runId).not.toBe(release.kickoffRunId);
    distinctFollowupRun = release.runId !== release.kickoffRunId;

    await expect(waitForReply(QA_SUBAGENT_SELF_YIELD_MARKER, 90_000)).resolves.toMatchObject({
      accountId: "default",
    });
  } catch (error) {
    throw new Error(
      [
        error instanceof Error ? error.message : String(error),
        `bus=${JSON.stringify(state.getSnapshot())}`,
        `gateway=${gateway.logs()}`,
      ].join("\n"),
      { cause: error },
    );
  }

  const outbound = outboundMessages();
  // Superseding the pause must publish only the acknowledgement and completion.
  expect(outbound).toHaveLength(outboundStartIndex + 2);
  const visibleRepliesBeforeQuiet = completionCount();
  expect(visibleRepliesBeforeQuiet).toBe(1);
  const waitForQuiet = () =>
    transport.waitForNoOutbound({ sinceIndex: outbound.length, quietMs: 1_000 });
  await waitForQuiet();
  const visibleRepliesAfterQuiet = completionCount();
  await gateway.restartAfterStateMutation(async () => {});
  await transport.waitReady({ gateway });
  await waitForQuiet();
  const visibleRepliesAfterRestart = completionCount();
  const requests = (await fetch(`${mock.baseUrl}/debug/requests`).then((response) =>
    response.json(),
  )) as Array<{ allInputText?: string; plannedToolName?: string; prompt?: string }>;
  const count = (matches: (request: (typeof requests)[number]) => boolean | undefined) =>
    requests.filter(matches).length;
  expect(requests).toHaveLength(3);
  const checks = [
    ["sessionsYieldCalls", count((request) => request.plannedToolName === "sessions_yield"), 1],
    [
      "childModelRequests",
      count(
        (request) =>
          request.prompt?.includes("Subagent self yield qa worker") ||
          request.prompt?.includes("Subagent self yield qa remote job finished"),
      ),
      2,
    ],
    [
      "requesterCompletionTurns",
      count((request) => request.allInputText?.includes("A background task completed.")),
      1,
    ],
    [
      "pauseNoticeRequests",
      count((request) => request.prompt?.includes("A child is paused awaiting a continuation")),
      0,
    ],
    ["visibleReplies", visibleRepliesBeforeQuiet, 1],
    ["duplicateRepliesAfterQuietWindow", visibleRepliesAfterQuiet - visibleRepliesBeforeQuiet, 0],
    [
      "duplicateRepliesAfterGatewayRestart",
      visibleRepliesAfterRestart - visibleRepliesAfterQuiet,
      0,
    ],
    ["distinctFollowupRun", distinctFollowupRun, true],
  ] as const;
  for (const [name, actual, expected] of checks) {
    expect(actual, name).toBe(expected);
  }
  const verdict = {
    schemaVersion: 1,
    scenario: "channel-handoff-adoption",
    status: "pass",
    channel: "qa-channel",
    provider: "mock-openai",
    gateway: "ephemeral",
    facts: Object.fromEntries(checks.map(([name, actual]) => [name, actual])),
  };
  await mkdir(path.dirname(VERDICT_PATH), { recursive: true });
  await writeFile(VERDICT_PATH, `${JSON.stringify(verdict, null, 2)}\n`, "utf8");
}, 180_000);
