// Real-provider task continuation and its Control UI retention share one Gateway.
import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { toErrorObject } from "@openclaw/normalization-core/error-coercion";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { Page } from "playwright";
import { afterEach, describe, expect, it } from "vitest";
import type {
  TasksGetResult,
  TasksListResult,
} from "../../../../packages/gateway-protocol/src/schema/tasks.js";
import { createControlUiE2eArtifactDir } from "../../../../ui/src/test-helpers/control-ui-e2e-artifacts.js";
import { waitForControlUiGatewayReady } from "../../../../ui/src/test-helpers/control-ui-e2e-readiness.js";
import {
  controlUiSessionUrl,
  resolvePlaywrightChromiumExecutablePath,
} from "../../../../ui/src/test-helpers/control-ui-e2e.js";
import { issueControlUiBrowserHandoff } from "../../../commands/control-ui-handoff.js";
import { clearRuntimeConfigSnapshot } from "../../../config/config.js";
import { loadSessionEntry } from "../../../config/sessions/session-accessor.js";
import type { GatewayClient } from "../../../gateway/client.js";
import { startGatewayServer, type GatewayServer } from "../../../gateway/server.js";
import { readSessionMessagesAsync } from "../../../gateway/session-transcript-readers.js";
import { isTruthyEnvValue } from "../../../infra/env.js";
import { resetPluginRuntimeStateForTest } from "../../../plugins/runtime.js";
import {
  extractAssistantPhaseText,
  extractFirstTextBlock,
} from "../../../shared/chat-message-content.js";
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

describeLive("subagent continuation live", () => {
  let state: OpenClawTestState | undefined;
  let server: GatewayServer | undefined;
  let client: GatewayClient | undefined;

  afterEach(async () => {
    await client?.stopAndWait().catch(() => undefined);
    await server?.close({ reason: "subagent continuation live test done" }).catch(() => undefined);
    await state?.cleanup().catch(() => undefined);
    clearRuntimeConfigSnapshot();
    resetPluginRuntimeStateForTest();
    client = undefined;
    server = undefined;
    state = undefined;
  });

  it(
    "completes a yielded child's original task after an ordinary parent continuation",
    async () => {
      const modelConfig = resolveLiveSubagentModelConfig();
      requireLiveSubagentAuth(modelConfig);
      const { chromium } = await import("playwright");
      // Resolve the installed browser before the fixture replaces HOME.
      const executablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
      const artifactDir = createControlUiE2eArtifactDir("subagent-continuation-live");
      const token = `subagent-continuation-${randomUUID()}`;
      const port = await getFreePort();
      const nonce = randomBytes(3).toString("hex").toUpperCase();
      const childToken = `REVIEW_COMPLETE_${nonce}`;
      const parentToken = `REVIEW_RECEIVED_${nonce}`;
      const initialAcknowledgement = "The release evidence check is waiting for approval.";
      const sessionKey = `agent:main:release-review-${nonce.toLowerCase()}`;
      state = await createLiveSubagentState("subagent-continuation-live");
      const config = liveSubagentConfig(modelConfig.modelKey, state.workspaceDir, port, token, {
        toolAllow: ["sessions_spawn", "sessions_send", "sessions_yield", "subagents"],
      });
      config.gateway = { ...config.gateway, controlUi: { enabled: true } };
      config.tools = { ...config.tools, codeMode: false };
      config.models = { ...config.models, catalogRefresh: { enabled: false } };
      await state.writeConfig(config);
      await fs.writeFile(
        path.join(state.workspaceDir, "AGENTS.md"),
        "This is a fictional release review. Follow the requested tool calls exactly.\n",
      );
      clearRuntimeConfigSnapshot();
      resetPluginRuntimeStateForTest();
      server = await startGatewayServer(port, {
        bind: "loopback",
        auth: { mode: "token", token },
        controlUiEnabled: true,
      });
      await server.startupSettled;
      const gateway = await createGatewayClient({ port, token });
      client = gateway;
      const readMessages = async (key: string) => {
        const entry = loadSessionEntry({ agentId: "main", sessionKey: key });
        if (!entry?.sessionId) {
          throw new Error("Live continuation session was not persisted");
        }
        return (
          await readSessionMessagesAsync(
            { agentId: "main", sessionEntry: entry, sessionId: entry.sessionId, sessionKey: key },
            { mode: "full", reason: "live child continuation proof" },
          )
        ).filter(isRecord);
      };
      const runParent = (message: string, expectFinal = true) =>
        gateway.request<AgentPayload>(
          "agent",
          { sessionKey, message, idempotencyKey: randomUUID(), deliver: false, timeout: 300 },
          { expectFinal, timeoutMs: REQUEST_TIMEOUT_MS },
        );
      await runParent(
        [
          "Delegate this fictional release review through native OpenClaw tools.",
          `Call sessions_spawn exactly once with ${JSON.stringify({
            task: [
              "You are checking fictional release evidence and need approval from your parent.",
              'Call sessions_yield exactly once with waitFor="message" and message="Waiting for release evidence approval.".',
              `After the parent supplies approval, return a normal final reply exactly ${childToken}.`,
              "Do not yield again and do not send the final through another tool.",
            ].join(" "),
            taskName: "release_evidence",
            label: "Verify release evidence",
            cleanup: "keep",
            context: "isolated",
          })}.`,
          `After the spawn is accepted, finish this turn with a normal final reply exactly: ${initialAcknowledgement}`,
          "Do not call sessions_yield yourself; the child owns the wait for approval.",
          `If the child's completion later wakes you, reply exactly ${parentToken}.`,
        ].join("\n"),
      );
      const paused = await waitFor("child waiting for parent approval", () =>
        listSubagentRunsForRequester(sessionKey).find(
          (run) => run.taskName === "release_evidence" && run.pauseReason === "sessions_yield",
        ),
      );
      const originalRunId = paused.runId;
      const originalTaskRunId = paused.taskRunId ?? paused.runId;
      const childSessionKey = paused.childSessionKey;
      const initialTasks = await gateway.request<TasksListResult>("tasks.list", {
        sessionKey,
      });
      const originalTask = initialTasks.tasks.find(
        (task) => task.childSessionKey === childSessionKey,
      );
      expect(originalTask).toMatchObject({
        status: "running",
        sessionKey,
        ownerKey: sessionKey,
        execution: { state: "waiting" },
      });
      if (!originalTask) {
        throw new Error("The yielded child has no public task record");
      }
      await gateway.request("sessions.patch", {
        key: sessionKey,
        label: "Release evidence review",
      });
      const browser = await chromium.launch({ executablePath, headless: true });
      let page: Page | undefined;
      let childFinalObserved = false;
      let stage = "open parent chat";
      try {
        page = await browser.newPage({
          viewport: { width: 1280, height: 900 },
          colorScheme: "light",
          locale: "en-US",
          serviceWorkers: "block",
        });
        await page.addInitScript(() => {
          localStorage.setItem(
            "openclaw:control-ui:community-invite",
            JSON.stringify({ dismissedAtMs: 1770000000000 }),
          );
        });
        const { browserUrl } = await issueControlUiBrowserHandoff({
          httpUrl: controlUiSessionUrl(`http://127.0.0.1:${port}/`, sessionKey),
          wsUrl: `ws://127.0.0.1:${port}`,
        });
        await page.goto(browserUrl);
        await waitForControlUiGatewayReady(page);
        const parentPage = page;
        const idleSend = parentPage.getByRole("button", {
          name: "Write a message to send.",
          exact: true,
        });
        const stop = parentPage.getByRole("button", { name: "Stop generating", exact: true });
        await parentPage.getByText(initialAcknowledgement, { exact: true }).waitFor();
        await idleSend.waitFor({ state: "visible" });
        expect(await stop.count()).toBe(0);
        const row = page.locator(`[data-subagent-task-id="${originalTask.id}"]`);
        await row.waitFor({ state: "visible" });
        expect(await row.getAttribute("aria-label")).toContain("Waiting");
        await page.screenshot({ path: path.join(artifactDir, "01-waiting-for-approval.png") });
        stage = "send ordinary parent continuation";
        const continuation = await runParent(
          [
            `Send the approval to the existing child with sessions_send exactly once, using ${JSON.stringify(
              {
                sessionKey: childSessionKey,
                message: `The release evidence is approved. Return your normal final exactly ${childToken}.`,
                timeoutSeconds: 30,
                watch: true,
              },
            )}.`,
            "Do not add mode, spawn another child, or send another message.",
            "After the tool returns, finish this turn with the normal final reply exactly: The approval is sent. I will report the child's result here.",
            "Do not call sessions_yield yourself.",
            `If the child's completion later wakes you, reply exactly ${parentToken}.`,
          ].join("\n"),
          false,
        );
        expect(continuation).toMatchObject({ status: "accepted" });
        stage = "observe child normal final";
        await waitFor("child normal final", async () => {
          const messages = await readMessages(childSessionKey);
          return messages.some(
            (message) =>
              message.role === "assistant" &&
              extractAssistantPhaseText(message)?.trim() === childToken,
          )
            ? true
            : undefined;
        });
        childFinalObserved = true;
        stage = "settle original task";
        const completedTask = await waitFor(
          "original task completion",
          async () => {
            const { task } = await gateway.request<TasksGetResult>("tasks.get", {
              taskId: originalTask.id,
            });
            return task.status === "completed" ? task : undefined;
          },
          120_000,
        );
        expect(completedTask).toMatchObject({
          id: originalTask.id,
          taskId: originalTask.taskId,
          runId: originalTask.runId,
          sessionKey,
          ownerKey: sessionKey,
          childSessionKey,
          execution: { state: "finished" },
          result: childToken,
        });
        const endedAt =
          typeof completedTask.endedAt === "number"
            ? completedTask.endedAt
            : Date.parse(completedTask.endedAt ?? "");
        stage = "observe parent delivery and activity expiry";
        const [retention, parentCompletion, delivery] = await Promise.allSettled([
          waitFor(
            "completed task retention period",
            () => {
              const elapsedMs = Date.now() - endedAt;
              return elapsedMs >= 60_000 ? elapsedMs : undefined;
            },
            80_000,
          ),
          waitFor("parent receives completion", async () => {
            const messages = await readMessages(sessionKey);
            return messages.some(
              (message) =>
                message.role === "assistant" &&
                extractAssistantPhaseText(message)?.trim() === parentToken,
            )
              ? true
              : undefined;
          }),
          waitFor(
            "original task delivery",
            async () => {
              const { task } = await gateway.request<TasksGetResult>("tasks.get", {
                taskId: originalTask.id,
              });
              return task.deliveryStatus === "delivered" ? task : undefined;
            },
            120_000,
          ),
        ]);
        if (retention.status === "rejected") {
          throw toErrorObject(retention.reason, "Activity retention wait failed");
        }
        if (parentCompletion.status === "rejected") {
          throw toErrorObject(parentCompletion.reason, "Parent completion failed");
        }
        if (delivery.status === "rejected") {
          throw toErrorObject(delivery.reason, "Task delivery failed");
        }
        stage = "verify expired activity after parent finishes";
        await idleSend.waitFor({ state: "visible" });
        expect(await stop.count()).toBe(0);
        const visibleParentReply = parentPage
          .getByRole("paragraph")
          .filter({ hasText: new RegExp(`^${parentToken}$`) });
        await visibleParentReply.waitFor();
        await visibleParentReply.scrollIntoViewIfNeeded();
        await row.waitFor({ state: "detached", timeout: 80_000 });
        expect(await parentPage.locator(".chat-subagent-activity").count()).toBe(0);
        expect(await idleSend.isVisible()).toBe(true);
        expect(await stop.count()).toBe(0);
        const rowAbsentAfterMs = Date.now() - endedAt;
        expect(rowAbsentAfterMs).toBeGreaterThanOrEqual(60_000);
        await parentPage.screenshot({
          path: path.join(artifactDir, "03-completed-row-expired.png"),
        });
        const parentMessages = await readMessages(sessionKey);
        const sends = parentMessages.flatMap((message) =>
          Array.isArray(message.content)
            ? message.content
                .filter(isRecord)
                .filter((block) => block.type === "toolCall" && block.name === "sessions_send")
            : [],
        );
        expect(sends).toHaveLength(1);
        expect(sends[0]?.arguments).toMatchObject({
          sessionKey: childSessionKey,
          timeoutSeconds: 30,
          watch: true,
        });
        expect(sends[0]?.arguments).not.toHaveProperty("mode");
        const sendResult = parentMessages.find((message) => message.toolName === "sessions_send");
        const receipt: unknown = JSON.parse(extractFirstTextBlock(sendResult) ?? "null");
        expect(receipt).toMatchObject({
          status: "accepted",
          mode: "resume",
          taskRunId: originalTaskRunId,
          sessionKey: childSessionKey,
          completion: "task",
        });
        // Completion input can travel as private runtime context, outside display history.
        const visibleCompletions = parentMessages.filter(
          (message) =>
            message.role === "assistant" &&
            extractAssistantPhaseText(message)?.trim() === parentToken,
        );
        expect(visibleCompletions).toHaveLength(1);
        const finalTasks = await gateway.request<TasksListResult>("tasks.list", { sessionKey });
        expect(finalTasks.tasks.filter((task) => task.childSessionKey === childSessionKey)).toEqual(
          [expect.objectContaining({ id: originalTask.id, status: "completed" })],
        );
        await fs.writeFile(
          path.join(artifactDir, "proof.json"),
          JSON.stringify(
            {
              originalTaskId: originalTask.id,
              originalRunId,
              originalTaskRunId,
              childFinalObserved,
              taskStatus: completedTask.status,
              deliveryStatus: delivery.value.deliveryStatus,
              visibleCompletionCount: visibleCompletions.length,
              retentionElapsedMs: retention.value,
              rowAbsentAfterMs,
              parentIdle: true,
            },
            null,
            2,
          ) + "\n",
        );
      } catch (error) {
        try {
          await fs.writeFile(
            path.join(artifactDir, "failure-messages.json"),
            JSON.stringify(await readMessages(sessionKey), null, 2) + "\n",
          );
          await page?.screenshot({ path: path.join(artifactDir, "failure-parent-chat.png") });
          const { task } = await gateway.request<TasksGetResult>("tasks.get", {
            taskId: originalTask.id,
          });
          const ui = page
            ? {
                initialAcknowledgementVisible: await page
                  .getByText(initialAcknowledgement, { exact: true })
                  .isVisible(),
                parentResultVisible: await page
                  .getByRole("paragraph")
                  .filter({ hasText: new RegExp(`^${parentToken}$`) })
                  .first()
                  .isVisible(),
                stopVisible: await page
                  .getByRole("button", { name: "Stop generating", exact: true })
                  .isVisible(),
                idleSendVisible: await page
                  .getByRole("button", { name: "Write a message to send.", exact: true })
                  .isVisible(),
                subagentRows: await page.locator("[data-subagent-task-id]").count(),
              }
            : undefined;
          await fs.writeFile(
            path.join(artifactDir, "failure.json"),
            JSON.stringify(
              {
                stage,
                childFinalObserved,
                originalTaskId: originalTask.id,
                status: task.status,
                execution: task.execution,
                deliveryStatus: task.deliveryStatus,
                ui,
              },
              null,
              2,
            ) + "\n",
          );
        } catch (captureError) {
          console.error("[subagent-continuation] Failure evidence capture failed:", captureError);
        }
        throw error;
      } finally {
        await browser.close();
      }
    },
    10 * 60_000,
  );
});
