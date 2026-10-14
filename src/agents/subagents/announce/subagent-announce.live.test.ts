// Live subagent announce E2E tests exercise real gateway, session, and provider
// flows for subagent completion delivery.
import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { toErrorObject as toLintErrorObject } from "@openclaw/normalization-core/error-coercion";
import { afterEach, describe, expect, it } from "vitest";
import { clearRuntimeConfigSnapshot } from "../../../config/config.js";
import { loadSessionEntry } from "../../../config/sessions/session-accessor.js";
import type { GatewayClient } from "../../../gateway/client.js";
import { startGatewayServer, type GatewayServer } from "../../../gateway/server.js";
import { readSessionMessagesAsync } from "../../../gateway/session-transcript-readers.js";
import { extractPayloadText } from "../../../gateway/test-helpers.agent-results.js";
import { isTruthyEnvValue } from "../../../infra/env.js";
import { resetPluginRuntimeStateForTest } from "../../../plugins/runtime.js";
import { normalizeInputProvenance } from "../../../sessions/input-provenance.js";
import type { OpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import { getFreePort } from "../../../test-utils/ports.js";
import { isLiveTestEnabled } from "../../live-test-helpers.js";
import { listSubagentRunsForRequester } from "../registry/subagent-registry.test-helpers.js";
import {
  createGatewayClient,
  createLiveSubagentState,
  liveSubagentConfig,
  REQUEST_TIMEOUT_MS,
  requireLiveSubagentAuth,
  resolveLiveSubagentModelConfig,
  waitFor,
  type AgentPayload,
} from "./subagent-announce.live.test-support.js";

const LIVE = isLiveTestEnabled() && isTruthyEnvValue(process.env.OPENCLAW_LIVE_SUBAGENT_E2E);
const describeLive = LIVE ? describe : describe.skip;

async function readCompletionProvenance(sessionKey: string, agentId: string) {
  const entry = loadSessionEntry({ agentId, sessionKey });
  if (!entry?.sessionId) {
    return undefined;
  }
  const messages = await readSessionMessagesAsync(
    {
      agentId,
      sessionEntry: entry,
      sessionId: entry.sessionId,
      sessionKey,
    },
    { mode: "full", reason: "live subagent completion provenance verification" },
  );
  for (const message of messages) {
    const record = message as { role?: unknown; provenance?: unknown };
    const provenance = normalizeInputProvenance(record.provenance);
    if (
      record.role === "user" &&
      (provenance?.sourceTool === "subagent_announce" ||
        provenance?.sourceTool === "subagent_settle")
    ) {
      return provenance;
    }
  }
  return undefined;
}

describeLive("subagent announce live", () => {
  let state: OpenClawTestState | undefined;
  let server: GatewayServer | undefined;
  let client: GatewayClient | undefined;

  afterEach(async () => {
    await client?.stopAndWait().catch(() => undefined);
    await server?.close({ reason: "subagent announce live test done" }).catch(() => undefined);
    await state?.cleanup().catch(() => undefined);
    clearRuntimeConfigSnapshot();
    resetPluginRuntimeStateForTest();
    client = undefined;
    server = undefined;
    state = undefined;
  });

  it(
    "records internal provenance through a real Gateway and provider",
    async () => {
      const modelConfig = resolveLiveSubagentModelConfig();
      requireLiveSubagentAuth(modelConfig);

      const token = `subagent-provenance-${randomUUID()}`;
      const port = await getFreePort();
      const nonce = randomBytes(3).toString("hex").toUpperCase();
      const childToken = `PROVENANCE_CHILD_${nonce}`;
      const sessionKey = `agent:main:live-subagent-provenance-${nonce.toLowerCase()}`;

      state = await createLiveSubagentState("subagent-provenance-live");
      await state.writeConfig(
        liveSubagentConfig(modelConfig.modelKey, state.workspaceDir, port, token),
      );
      clearRuntimeConfigSnapshot();
      resetPluginRuntimeStateForTest();

      server = await startGatewayServer(port, {
        bind: "loopback",
        auth: { mode: "token", token },
        controlUiEnabled: false,
      });
      await server.startupSettled;
      client = await createGatewayClient({ port, token });

      await client.request<AgentPayload>(
        "agent",
        {
          sessionKey,
          idempotencyKey: `subagent-provenance-${randomUUID()}`,
          deliver: false,
          timeout: 300,
          message: [
            "Run this exact OpenClaw subagent scenario. Use tool calls, not prose.",
            `Call sessions_spawn once with exactly this JSON input: ${JSON.stringify({
              task: `Reply exactly ${childToken} and nothing else.`,
              taskName: "provenance_child",
              cleanup: "keep",
              context: "isolated",
            })}.`,
            `After the spawn is accepted, call sessions_yield with message="waiting for ${childToken}".`,
          ].join("\n"),
        },
        { expectFinal: true, timeoutMs: REQUEST_TIMEOUT_MS },
      );

      const provenance = await waitFor("internal completion provenance", () =>
        readCompletionProvenance(sessionKey, "main"),
      );
      expect(provenance).toMatchObject({
        kind: "inter_session",
        sourceChannel: "internal",
        sourceTool: expect.stringMatching(/^subagent_(?:announce|settle)$/),
      });
    },
    10 * 60_000,
  );

  it(
    "keeps issue 82913 busy-parent completion announce pending until transcript delivery",
    async ({ skip }) => {
      if (!isTruthyEnvValue(process.env.OPENCLAW_SUBAGENT_ISSUE_82913_REPRO)) {
        skip(
          "[issue-82913] skip: set OPENCLAW_SUBAGENT_ISSUE_82913_REPRO=1 to run this focused repro",
        );
        return;
      }
      const modelConfig = resolveLiveSubagentModelConfig();
      requireLiveSubagentAuth(modelConfig);

      const token = `subagent-82913-${randomUUID()}`;
      const port = await getFreePort();
      const modelKey = modelConfig.modelKey;
      const nonce = randomBytes(3).toString("hex").toUpperCase();
      const childToken = `ISSUE_82913_CHILD_${nonce}`;
      const parentToken = `ISSUE_82913_PARENT_SAW_${nonce}`;
      const sessionKey = `agent:main:issue-82913-${nonce.toLowerCase()}`;

      state = await createLiveSubagentState("subagent-issue-82913-live");
      await state.writeConfig(
        liveSubagentConfig(modelKey, state.workspaceDir, port, token, {
          queue: { mode: "collect" },
          toolAllow: ["sessions_spawn", "bash"],
        }),
      );
      clearRuntimeConfigSnapshot();
      resetPluginRuntimeStateForTest();

      server = await startGatewayServer(port, {
        bind: "loopback",
        auth: { mode: "token", token },
        controlUiEnabled: false,
      });
      await server.startupSettled;
      client = await createGatewayClient({ port, token });

      let initialError: unknown;
      let parentObservedAt: number | undefined;
      let parentText: string | undefined;
      const initialRequest = client.request<AgentPayload>(
        "agent",
        {
          sessionKey,
          idempotencyKey: `issue-82913-${randomUUID()}`,
          deliver: false,
          timeout: 240,
          message: [
            "Run this exact OpenClaw busy-parent subagent scenario. Use tool calls, not prose.",
            `Use nonce ${nonce}.`,
            `Step 1: call sessions_spawn with exactly this JSON input: ${JSON.stringify({
              task: `Reply exactly ${childToken} and nothing else.`,
              taskName: "issue_82913_child",
              cleanup: "keep",
              context: "isolated",
            })}.`,
            'Step 2: after spawn returns status="accepted", immediately call the bash tool with command exactly: sleep 35; printf ISSUE_82913_PARENT_TOOL_DONE.',
            "Do not call sessions_yield at any point in this scenario.",
            `Step 3: after the child completion event is visible in your conversation, reply exactly ${parentToken}.`,
            `Do not reply with ${parentToken} before the child completion event is visible.`,
          ].join("\n"),
        },
        { expectFinal: true, timeoutMs: REQUEST_TIMEOUT_MS },
      );
      initialRequest
        .then((response) => {
          parentObservedAt = Date.now();
          parentText = extractPayloadText(response.result);
        })
        .catch((error: unknown) => {
          initialError = error;
        });

      const completedRunBeforeDelivery = await waitFor("issue 82913 child completion", () => {
        if (initialError) {
          throw toLintErrorObject(initialError, "Non-Error thrown");
        }
        return listSubagentRunsForRequester(sessionKey).find(
          (run) =>
            run.taskName === "issue_82913_child" &&
            run.completion?.resultText?.includes(childToken) === true &&
            run.execution.outcome?.status === "ok",
        );
      });
      expect(completedRunBeforeDelivery.delivery?.announcedAt).toBeUndefined();
      expect(parentObservedAt).toBeUndefined();

      const parent = await initialRequest;
      parentObservedAt ??= Date.now();
      parentText ??= extractPayloadText(parent.result);
      expect(parentText).toContain(parentToken);

      const completedRun = await waitFor("issue 82913 delivered completion announce", () =>
        listSubagentRunsForRequester(sessionKey).find(
          (run) =>
            run.runId === completedRunBeforeDelivery.runId &&
            typeof run.delivery?.enqueuedAt === "number" &&
            typeof run.delivery?.deliveredAt === "number" &&
            typeof run.delivery?.announcedAt === "number",
        ),
      );
      const enqueuedAt = completedRun.delivery?.enqueuedAt ?? 0;
      const deliveredAt = completedRun.delivery?.deliveredAt ?? 0;
      const announcedAt = completedRun.delivery?.announcedAt ?? 0;
      const enqueuedToDeliveredMs = deliveredAt - enqueuedAt;
      const announcedToParentObservedMs = Math.abs(parentObservedAt - announcedAt);
      console.log(
        `[issue-82913] repro ${JSON.stringify({
          runId: completedRun.runId,
          childEndedAt: completedRun.execution.endedAt,
          completionEnqueuedAt: enqueuedAt,
          completionDeliveredAt: deliveredAt,
          completionAnnouncedAt: announcedAt,
          parentObservedAt,
          enqueuedToDeliveredMs,
          announcedToParentObservedMs,
        })}`,
      );
      expect(completedRun.delivery?.announcedAt).toBe(deliveredAt);
      expect(enqueuedToDeliveredMs).toBeGreaterThan(10_000);
      expect(announcedToParentObservedMs).toBeLessThan(20_000);
    },
    10 * 60_000,
  );

  it(
    "runs parallel isolated Gemini subagents with tool-heavy schemas",
    async ({ skip }) => {
      const modelConfig = resolveLiveSubagentModelConfig();
      if (!modelConfig.modelKey.startsWith("google/")) {
        skip(
          "[subagent-stress] skip: set OPENCLAW_LIVE_SUBAGENT_E2E_MODEL=google/gemini-3.1-pro-preview",
        );
        return;
      }
      requireLiveSubagentAuth(modelConfig);

      const token = `subagent-stress-${randomUUID()}`;
      const port = await getFreePort();
      const nonce = randomBytes(3).toString("hex").toUpperCase();
      const sessionKey = `agent:main:live-subagent-stress-${nonce.toLowerCase()}`;
      const childTokens = [1, 2, 3].map((index) => `GEMINI_STRESS_${nonce}_${index}`);
      const parentToken = `GEMINI_STRESS_PARENT_${nonce}`;

      state = await createLiveSubagentState("subagent-gemini-stress-live", {
        OPENCLAW_DEBUG_MODEL_TRANSPORT: "1",
        OPENCLAW_DEBUG_MODEL_PAYLOAD: "tools",
        OPENCLAW_DEBUG_SSE: "events",
      });
      await fs.writeFile(
        path.join(state.workspaceDir, "package.json"),
        `${JSON.stringify({ name: "openclaw-gemini-stress-live", private: true }, null, 2)}\n`,
        "utf8",
      );
      await fs.writeFile(
        path.join(state.workspaceDir, "AGENTS.md"),
        "OpenClaw live stress test workspace. Keep responses concise.\n",
        "utf8",
      );
      await state.writeConfig(
        liveSubagentConfig(modelConfig.modelKey, state.workspaceDir, port, token, {
          toolAllow: [
            "sessions_spawn",
            "sessions_yield",
            "subagents",
            "bash",
            "read",
            "web_search",
            "memory_search",
          ],
        }),
      );
      clearRuntimeConfigSnapshot();
      resetPluginRuntimeStateForTest();

      server = await startGatewayServer(port, {
        bind: "loopback",
        auth: { mode: "token", token },
        controlUiEnabled: false,
      });
      await server.startupSettled;
      client = await createGatewayClient({ port, token });

      let initialError: unknown;
      const initialRequest = client.request<AgentPayload>(
        "agent",
        {
          sessionKey,
          idempotencyKey: `live-subagent-stress-${randomUUID()}`,
          deliver: false,
          timeout: 420,
          message: [
            "Run this exact OpenClaw Gemini subagent stress scenario. Use tool calls, not prose.",
            `Use nonce ${nonce}.`,
            "Spawn all three children before waiting for any child result.",
            ...childTokens.map((childToken, index) => {
              const childNumber = index + 1;
              return `Call sessions_spawn for child ${childNumber} with exactly this JSON input: ${JSON.stringify(
                {
                  task: [
                    `You are stress child ${childNumber}.`,
                    "Use available tools for a tiny multi-tool check.",
                    "First read package.json if the read tool is available.",
                    "Then run a tiny shell command if the bash tool is available: printf openclaw.",
                    "If web_search or memory_search is available, use at most one small query.",
                    `After the tool work, reply exactly ${childToken}.`,
                  ].join(" "),
                  taskName: `gemini_stress_${childNumber}`,
                  cleanup: "keep",
                  context: "isolated",
                },
              )}.`;
            }),
            `After the three spawn calls are accepted, call sessions_yield with message="waiting for ${childTokens.join(
              ",",
            )}" and wait for all child completion events.`,
            `Reply exactly ${parentToken} only after all three child tokens are visible.`,
          ].join("\n"),
        },
        { expectFinal: true, timeoutMs: REQUEST_TIMEOUT_MS },
      );
      initialRequest.catch((error: unknown) => {
        initialError = error;
      });

      const completedRuns = await waitFor("three Gemini stress child completions", () => {
        if (initialError) {
          throw toLintErrorObject(initialError, "Non-Error thrown");
        }
        const runs = listSubagentRunsForRequester(sessionKey).filter((run) =>
          run.taskName?.startsWith("gemini_stress_"),
        );
        const completed = childTokens.every((childToken) =>
          runs.some(
            (run) =>
              run.completion?.resultText?.includes(childToken) === true &&
              run.execution.outcome?.status === "ok",
          ),
        );
        return completed ? runs : undefined;
      });

      expect(completedRuns).toHaveLength(3);
      for (const childToken of childTokens) {
        expect(completedRuns.some((run) => run.completion?.resultText?.includes(childToken))).toBe(
          true,
        );
      }

      const parent = await initialRequest;
      expect(extractPayloadText(parent.result)).toContain(parentToken);
    },
    12 * 60_000,
  );
});
