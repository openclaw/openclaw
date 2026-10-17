import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { afterEach, describe, expect, it } from "vitest";
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

describe("plugin subagent sessions_yield follow-up", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).toReversed()) {
      await cleanup();
    }
  });

  async function startFixtureGateway() {
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
    return { state, transport, mock, gateway };
  }

  it("announces to the original requester only after the follow-up run ends", async () => {
    const { state, transport, mock, gateway } = await startFixtureGateway();
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

    const failureContext = (error: unknown) =>
      new Error(
        [
          error instanceof Error ? error.message : String(error),
          `bus=${JSON.stringify(state.getSnapshot())}`,
          `gateway=${gateway.logs()}`,
        ].join("\n"),
        { cause: error },
      );
    let distinctFollowupRun: boolean;

    try {
      // The kickoff reply only acknowledges the spawn; it carries no child result.
      await waitForReply("QA-SELF-YIELD-SPAWNED", 30_000);
      const followUp = (await post("follow-up", 202)) as {
        kickoffRunId?: string;
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
      });
      expect(release.kickoffRunId).toBeTruthy();
      expect(release.runId).toBe(followUp.runId);
      expect(release.runId).not.toBe(release.kickoffRunId);
      distinctFollowupRun = release.runId !== release.kickoffRunId;

      const completion = await waitForReply(QA_SUBAGENT_SELF_YIELD_MARKER, 90_000);
      expect(completion.accountId).toBe("default");
    } catch (error) {
      throw failureContext(error);
    }

    const outbound = outboundMessages();
    // The follow-up supersedes the paused turn before its notice publishes, so the
    // requester sees only the spawn acknowledgement and the one completion announcement.
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
    const handoffRequests = requests.filter(
      (request) =>
        request.prompt?.includes("Subagent self yield qa worker") ||
        request.prompt?.includes("Subagent self yield qa remote job finished"),
    );
    // Only the registry completion turn may wake the original requester.
    const requesterCompletionTurns = requests.filter((request) =>
      request.allInputText?.includes("A background task completed."),
    ).length;
    const pauseNoticeRequests = requests.filter((request) =>
      request.prompt?.includes("A child is paused awaiting a continuation"),
    ).length;
    expect(requests).toHaveLength(3);
    const verdict = {
      schemaVersion: 1,
      scenario: "channel-handoff-adoption",
      status: "pass",
      channel: "qa-channel",
      provider: "mock-openai",
      gateway: "ephemeral",
      facts: {
        sessionsYieldCalls: requests.filter(
          (request) => request.plannedToolName === "sessions_yield",
        ).length,
        childModelRequests: handoffRequests.length,
        requesterCompletionTurns,
        pauseNoticeRequests,
        visibleReplies: visibleRepliesBeforeQuiet,
        duplicateRepliesAfterQuietWindow: visibleRepliesAfterQuiet - visibleRepliesBeforeQuiet,
        duplicateRepliesAfterGatewayRestart: visibleRepliesAfterRestart - visibleRepliesAfterQuiet,
        distinctFollowupRun,
      },
    };
    expect(verdict.facts).toEqual({
      sessionsYieldCalls: 1,
      childModelRequests: 2,
      requesterCompletionTurns: 1,
      pauseNoticeRequests: 0,
      visibleReplies: 1,
      duplicateRepliesAfterQuietWindow: 0,
      duplicateRepliesAfterGatewayRestart: 0,
      distinctFollowupRun: true,
    });
    await mkdir(path.dirname(VERDICT_PATH), { recursive: true });
    await writeFile(VERDICT_PATH, `${JSON.stringify(verdict, null, 2)}\n`, "utf8");
  }, 180_000);
});
