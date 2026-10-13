import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { expect, it } from "vitest";
import { createControlUiE2eSuite } from "../../../ui/src/e2e/control-ui-e2e-suite.test-support.ts";
import { controlUiSessionUrl } from "../../../ui/src/test-helpers/control-ui-e2e.ts";
import { createQaCrablineTransportAdapter } from "./crabline-transport.ts";
import { createQaGatewayChild } from "./gateway-child.ts";
import { redactQaGatewayDebugText } from "./gateway-log-redaction.ts";
import { isQaPosixProcessGroupAlive, signalQaPosixProcessGroup } from "./posix-process-group.ts";
import { hasToolDefinition } from "./providers/mock-openai/mock-openai-directives.ts";
import { buildAssistantEvents } from "./providers/mock-openai/mock-openai-events.ts";
import {
  extractLastUserText,
  extractToolOutput,
  hasToolOutput,
  splitMockConversationContext,
} from "./providers/mock-openai/mock-openai-input.ts";
import { buildToolCallEventsWithArgs } from "./providers/mock-openai/mock-openai-tooling.ts";
import {
  readRawQaSessionStore,
  readSessionTranscriptSummary,
} from "./suite-runtime-agent-session.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI cross-channel automation management with a real Gateway",
  startServerBeforeBrowser: true,
});

const captureUiProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
type AutomationAction = "list" | "get" | "update" | "run" | "remove";
const actions = ["list", "get", "update", "run", "remove"] as const;
const automationName = "Telegram-created reminder _literal_";
const updatedReminderMessage = "Complete the reminder updated from Control UI.";
const scheduledReply = "Scheduled reminder completed.";

function readResult(text: string): Record<string, unknown> {
  const value: unknown = JSON.parse(text);
  if (!isRecord(value)) {
    throw new Error("Automation tool returned no object result");
  }
  return value;
}

async function startAutomationProvider() {
  const requests = new Map<string, Record<string, unknown>>();
  const results = new Map<string, string>();
  const toolAvailability = new Map<string, boolean>();
  let restartHold:
    | {
        marker: string;
        recovering: boolean;
        reached: boolean;
      }
    | undefined;
  const observations: {
    marker: string | null;
    currentMarker: string | null;
    hasOutput: boolean;
    toolAvailable: boolean;
  }[] = [];
  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        chunks.push(Buffer.from(chunk));
      }
      if (request.method !== "POST" || request.url !== "/v1/responses") {
        response.writeHead(404).end();
        return;
      }
      const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (!isRecord(body) || !Array.isArray(body.input)) {
        throw new Error("Expected a Responses request");
      }
      const input = body.input.filter(isRecord);
      const userText = extractLastUserText(input);
      const markerPattern = /\[automation-proof:([a-z-]+)\]/u;
      const marker =
        markerPattern.exec(userText)?.[1] ??
        (restartHold && JSON.stringify(input).includes(`[automation-proof:${restartHold.marker}]`)
          ? restartHold.marker
          : undefined);
      if (restartHold && marker === restartHold.marker && !restartHold.recovering) {
        restartHold.reached = true;
        // The original request remains effect-free until its owned Gateway dies.
        // Closing that connection releases the hold; no response is replayed.
        await new Promise<void>((resolve) => {
          response.once("close", resolve);
        });
        return;
      }
      const currentMarker = markerPattern.exec(splitMockConversationContext(userText).current)?.[1];
      const args = marker ? requests.get(marker) : undefined;
      const output = extractToolOutput(input);
      const hasOutput = hasToolOutput(input);
      const toolAvailable = hasToolDefinition(body, "automations");
      observations.push({
        marker: marker && requests.has(marker) ? marker : null,
        currentMarker: currentMarker && requests.has(currentMarker) ? currentMarker : null,
        hasOutput,
        toolAvailable,
      });
      if (observations.length > 16) {
        observations.shift();
      }
      if (marker && args && !hasOutput) {
        // A retry must not erase an earlier exposure of an owner-only tool.
        toolAvailability.set(marker, toolAvailability.get(marker) === true || toolAvailable);
      }
      if (marker && args && hasOutput) {
        results.set(marker, output);
      }
      const events =
        args && !hasOutput
          ? toolAvailable
            ? buildToolCallEventsWithArgs("automations", args)
            : buildAssistantEvents(`${marker}: Automation tools are unavailable for this caller.`)
          : buildAssistantEvents(
              marker && args ? `${marker}:\n\n\`\`\`json\n${output}\n\`\`\`` : scheduledReply,
            );
      if (body.stream === true) {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""));
      } else {
        const completed = events.find((event) => event.type === "response.completed");
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(completed?.response));
      }
    })().catch((error: unknown) => {
      response.writeHead(500).end(error instanceof Error ? error.message : String(error));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Automation provider did not bind a loopback port");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    results,
    toolAvailability,
    observations,
    holdInitialRequestForRestart(marker: string) {
      const held = { marker, recovering: false, reached: false };
      restartHold = held;
      return {
        get originalRequestReached() {
          return held.reached;
        },
        allowRecoveredRequests() {
          held.recovering = true;
        },
      };
    },
    async stop() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}

function managementArgs(action: AutomationAction, jobId: string) {
  return {
    action,
    ...(action === "list" ? { includeDisabled: true } : { jobId }),
    ...(action === "update"
      ? {
          job: {
            name: "Reminder updated from Control UI",
            payload: { message: updatedReminderMessage },
          },
        }
      : {}),
    ...(action === "run" ? { runMode: "force" } : {}),
  };
}

suite.define(() => {
  it.skipIf(process.platform === "win32")(
    "an ordinary Control UI turn creates a disabled automation after its Gateway is replaced",
    { timeout: 240_000 },
    async () => {
      const proofDir = suite.artifactDir;
      const provider = await startAutomationProvider();
      const owner = createQaGatewayChild();
      const marker = "recovered-create";
      const checkpoint = provider.holdInitialRequestForRestart(marker);
      const jobName = "Disabled restart recovery proof";
      provider.requests.set(marker, {
        action: "add",
        job: {
          name: jobName,
          enabled: false,
          schedule: { kind: "every", everyMs: 3_600_000 },
          sessionTarget: "isolated",
          payload: { kind: "agentTurn", message: "Synthetic disabled recovery reminder." },
          delivery: { mode: "none" },
        },
      });
      const errors: unknown[] = [];
      try {
        const repoRoot = process.cwd();
        const gateway = await owner.start({
          repoRoot,
          command: {
            executablePath: process.execPath,
            argsPrefix: [path.join(repoRoot, "openclaw.mjs")],
            cwd: repoRoot,
            usePackagedPlugins: true,
          },
          providerMode: "mock-openai",
          providerBaseUrl: provider.baseUrl,
          primaryModel: "mock-openai/gpt-5.6-luna",
          alternateModel: "mock-openai/gpt-5.6-luna-alt",
          forcedRuntime: "openclaw",
          transportBaseUrl: "http://127.0.0.1",
          controlUiEnabled: false,
          controlUiAllowedOrigins: [new URL(suite.server.baseUrl).origin],
          mutateConfig: (cfg) => ({
            ...cfg,
            plugins: { ...cfg.plugins, slots: { ...cfg.plugins?.slots, memory: "none" } },
            memory: { ...cfg.memory, search: { ...cfg.memory?.search, enabled: false } },
            // Ordinary full-access continuation retains non-replay-safe tools.
            // Explicit restartSafe execution would intentionally hide automations.
            tools: {
              profile: "full",
              allow: ["automations", "session_status"],
              exec: { mode: "full" },
              codeMode: false,
              toolSearch: false,
            },
            agents: {
              ...cfg.agents,
              entries: {
                ...cfg.agents?.entries,
                qa: {
                  ...cfg.agents?.entries?.qa,
                  identity: { name: "Recovery proof" },
                  tools: { profile: "full", allow: ["automations", "session_status"] },
                },
              },
            },
          }),
        });
        const sessionKey = `agent:qa:dashboard:operator-recovery-${randomUUID()}`;
        await gateway.call("sessions.create", {
          key: sessionKey,
          label: "Restart automation proof",
        });
        await suite.withPage(
          {
            locale: "en-US",
            ...(captureUiProof
              ? { recordVideo: { dir: proofDir, size: { width: 1280, height: 900 } } }
              : {}),
            viewport: { width: 1280, height: 900 },
            serviceWorkers: "block",
          },
          async ({ page }) => {
            await page.addInitScript(
              ({ gatewayUrl, token }) => {
                (
                  window as Window & {
                    __OPENCLAW_NATIVE_CONTROL_AUTH__?: { gatewayUrl: string; token: string };
                  }
                )["__OPENCLAW_NATIVE_CONTROL_AUTH__"] = { gatewayUrl, token };
              },
              { gatewayUrl: gateway.wsUrl, token: gateway.token },
            );
            await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
            const prompt = `Create one disabled hourly reminder after continuing this turn. [automation-proof:${marker}]`;
            await page.locator(".agent-chat__composer-combobox textarea").fill(prompt);
            await page.getByRole("button", { name: "Send message" }).click();
            await expect
              .poll(() => checkpoint.originalRequestReached, { timeout: 60_000 })
              .toBe(true);
            await expect
              .poll(
                async () => {
                  const entry = (await readRawQaSessionStore({ gateway }))[sessionKey];
                  const transcript = await readSessionTranscriptSummary({ gateway }, sessionKey);
                  return (
                    Boolean(entry?.restartRecoveryDeliveryRunId) &&
                    transcript.userMessageCount === 1
                  );
                },
                { timeout: 30_000 },
              )
              .toBe(true);
            expect(provider.results.has(marker)).toBe(false);
            const before = (await readRawQaSessionStore({ gateway }))[sessionKey];
            if (!before?.restartRecoveryDeliveryRunId) {
              throw new Error("Original Control UI admission lost its recovery claim");
            }
            const originalRunId = before.restartRecoveryDeliveryRunId;
            if (captureUiProof) {
              await page.screenshot({ path: path.join(proofDir, "recovery-before-restart.png") });
            }
            const originalPid = gateway.pid;
            if (originalPid === null) {
              throw new Error("Owned Gateway has no process identity");
            }
            // Replace the exact owned process group, not an operator service.
            // Startup reconciles the real chat admission; no claim is seeded.
            expect(signalQaPosixProcessGroup(originalPid, "SIGKILL")).toBeUndefined();
            await expect
              .poll(() => isQaPosixProcessGroupAlive(originalPid), {
                timeout: 30_000,
              })
              .toBe(false);
            checkpoint.allowRecoveredRequests();
            await gateway.restartAfterStateMutation(async () => {});
            expect(gateway.pid).not.toBe(originalPid);
            await expect.poll(() => provider.results.has(marker), { timeout: 90_000 }).toBe(true);
            const created = readResult(provider.results.get(marker) ?? "null");
            expect(created).toMatchObject({ name: jobName, enabled: false });
            expect(typeof created.id).toBe("string");
            expect(await gateway.call("cron.get", { id: String(created.id) })).toMatchObject({
              id: created.id,
              name: jobName,
              enabled: false,
              owner: { sessionKey },
            });
            await expect
              .poll(
                async () => {
                  const after = (await readRawQaSessionStore({ gateway }))[sessionKey];
                  return {
                    sessionId: after?.sessionId,
                    status: after?.status,
                    originalTurnSettled:
                      after?.restartRecoveryTerminalRunIds?.includes(originalRunId),
                    recoveryClaimCleared: after?.restartRecoveryDeliveryRunId === undefined,
                  };
                },
                { timeout: 30_000 },
              )
              .toEqual({
                sessionId: before.sessionId,
                status: "done",
                originalTurnSettled: true,
                recoveryClaimCleared: true,
              });
            const history = await gateway.call("chat.history", { sessionKey, limit: 30 });
            if (!isRecord(history) || !Array.isArray(history.messages)) {
              throw new Error("Recovered session returned no history");
            }
            // Recovery persists an internal continuation as role:user too; count
            // the exact original ingress, not every user-shaped system input.
            const originalInputs = history.messages.filter((message) => {
              if (!isRecord(message) || message.role !== "user") {
                return false;
              }
              const text =
                typeof message.content === "string"
                  ? message.content
                  : Array.isArray(message.content)
                    ? message.content
                        .flatMap((block) =>
                          isRecord(block) && block.type === "text" && typeof block.text === "string"
                            ? [block.text]
                            : [],
                        )
                        .join("\n")
                    : undefined;
              return text === prompt;
            });
            expect(originalInputs).toHaveLength(1);
            await page
              .getByText(new RegExp(`^${marker}:`, "u"))
              .first()
              .waitFor();
            if (captureUiProof) {
              await page.screenshot({
                path: path.join(proofDir, "recovery-created-disabled-automation.png"),
              });
            }
            await writeFile(
              path.join(proofDir, "recovery-verdict.json"),
              `${JSON.stringify(
                {
                  gateway: "real isolated Gateway process replacement",
                  provider: "deterministic local Responses API; only model behavior is synthetic",
                  ingress: "ordinary authenticated Control UI chat send",
                  originalUserTurns: 1,
                  recovery: "automatic; no second user turn or injected claim",
                  automation: { name: created.name, enabled: created.enabled, persisted: true },
                  operatorAdmin:
                    "recovered automation creation succeeded through real tool/RPC scope checks",
                },
                null,
                2,
              )}\n`,
            );
          },
        );
      } catch (error) {
        errors.push(error);
      }
      errors.push(
        ...(await owner.stop({ preserveToDir: path.join(proofDir, "recovery-gateway") })).errors,
      );
      try {
        await provider.stop();
      } catch (error) {
        errors.push(error);
      }
      if (errors.length) {
        throw new AggregateError(errors, "Control UI restart automation proof failed");
      }
    },
  );
  it(
    "configured owners and admin chat manage a Telegram-created job while a non-owner cannot",
    {
      timeout: 240_000,
    },
    async () => {
      const proofDir = suite.artifactDir;
      const provider = await startAutomationProvider();
      const owner = createQaGatewayChild();
      const transport = await createQaCrablineTransportAdapter({
        outputDir: proofDir,
        transportPolicy: { senderAllowlist: ["100001", "100002", "100003"] },
        selection: {
          channel: "telegram",
          channelDriver: "crabline",
          capabilityMatrixPath: "crabline-channel-driver-capabilities.json",
          providerReadinessArtifactPath: "crabline-provider-readiness.json",
        },
      });
      const errors: unknown[] = [];
      try {
        const repoRoot = process.cwd();
        const gateway = await owner.start({
          repoRoot,
          command: {
            executablePath: process.execPath,
            argsPrefix: [path.join(repoRoot, "openclaw.mjs")],
            cwd: repoRoot,
            usePackagedPlugins: true,
          },
          providerMode: "mock-openai",
          providerBaseUrl: provider.baseUrl,
          primaryModel: "mock-openai/gpt-5.6-luna",
          alternateModel: "mock-openai/gpt-5.6-luna-alt",
          forcedRuntime: "openclaw",
          transport,
          transportBaseUrl: "http://127.0.0.1",
          controlUiEnabled: false,
          controlUiAllowedOrigins: [new URL(suite.server.baseUrl).origin],
          mutateConfig: (cfg) => ({
            ...cfg,
            // Channel admission includes a non-owner; only configured owners get automation tools.
            commands: { ...cfg.commands, ownerAllowFrom: ["telegram:100001", "telegram:100002"] },
            session: { ...cfg.session, dmScope: "per-channel-peer" },
            plugins: { ...cfg.plugins, slots: { ...cfg.plugins?.slots, memory: "none" } },
            memory: { ...cfg.memory, search: { ...cfg.memory?.search, enabled: false } },
            // Keep a regular tool available so non-owner turns reach the provider.
            tools: {
              profile: "full",
              allow: ["automations", "session_status"],
              codeMode: false,
              toolSearch: false,
            },
            agents: {
              ...cfg.agents,
              entries: {
                ...cfg.agents?.entries,
                qa: {
                  ...cfg.agents?.entries?.qa,
                  identity: { name: "Automation proof" },
                  tools: { profile: "full", allow: ["automations", "session_status"] },
                },
              },
            },
          }),
        });
        await transport.waitReady({ gateway });
        provider.requests.set("create", {
          action: "add",
          job: {
            name: automationName,
            enabled: false,
            schedule: { kind: "every", everyMs: 3_600_000 },
            sessionTarget: "isolated",
            payload: { kind: "agentTurn", message: "Complete this synthetic reminder." },
            delivery: { mode: "none" },
          },
        });
        await transport.sendInbound({
          accountId: transport.accountId,
          conversation: { id: "100001", kind: "direct" },
          senderId: "100001",
          text: "Create a disabled hourly reminder. [automation-proof:create]",
        });
        await transport.waitForOutbound({ textIncludes: "create:", timeoutMs: 60_000 });
        const created = readResult(provider.results.get("create") ?? "null");
        expect(created).toMatchObject({
          name: automationName,
          owner: { sessionKey: expect.stringContaining(":telegram:") },
          scheduledToolPolicy: { mode: "account" },
          payload: { kind: "agentTurn", toolsAllow: ["*"] },
        });
        if (!isRecord(created.payload)) {
          throw new Error("Created automation has no payload");
        }
        const creatorPayload = created.payload;
        expect(typeof created.id).toBe("string");
        const jobId = String(created.id);
        const managementAuditEvents = () =>
          gateway
            .logs()
            .split("\n")
            .filter((line) => line.includes("cron: admin management"));
        expect(managementAuditEvents()).toHaveLength(0);
        const jobBeforeNonOwner = await gateway.call("cron.get", { id: jobId });
        const runsBeforeNonOwner = await gateway.call("cron.runs", { id: jobId });
        const nonOwnerMarker = "non-owner-remove";
        provider.requests.set(nonOwnerMarker, managementArgs("remove", jobId));
        await transport.sendInbound({
          accountId: transport.accountId,
          conversation: { id: "100003", kind: "direct" },
          senderId: "100003",
          text: `Remove the other conversation's reminder. [automation-proof:${nonOwnerMarker}]`,
        });
        const nonOwnerReply = await transport.waitForOutbound({
          textIncludes: `${nonOwnerMarker}:`,
          timeoutMs: 60_000,
        });
        expect(provider.toolAvailability.get(nonOwnerMarker)).toBe(false);
        expect(provider.results.has(nonOwnerMarker)).toBe(false);
        expect(nonOwnerReply.text).toContain("Automation tools are unavailable for this caller.");
        expect(await gateway.call("cron.get", { id: jobId })).toEqual(jobBeforeNonOwner);
        expect(await gateway.call("cron.runs", { id: jobId })).toEqual(runsBeforeNonOwner);
        expect(managementAuditEvents()).toHaveLength(0);

        const ownerResults: Record<string, string> = {};
        for (const action of ["list", "get"] as const) {
          const marker = `owner-${action}`;
          provider.requests.set(marker, managementArgs(action, jobId));
          const outboundIndex = transport.state
            .getSnapshot()
            .messages.filter((message) => message.direction === "outbound").length;
          await transport.sendInbound({
            accountId: transport.accountId,
            conversation: { id: "100002", kind: "direct" },
            senderId: "100002",
            text: `Manage the other conversation's reminder. [automation-proof:${marker}]`,
          });
          const reply = await transport.waitForOutbound({
            textIncludes: `${marker}:`,
            sinceIndex: outboundIndex,
            timeoutMs: 60_000,
          });
          const output = provider.results.get(marker) ?? "";
          expect(provider.toolAvailability.get(marker)).toBe(true);
          if (action === "list") {
            expect(readResult(output).jobs).toEqual(
              expect.arrayContaining([expect.objectContaining({ id: jobId })]),
            );
          } else {
            expect(readResult(output)).toMatchObject({ id: jobId, name: automationName });
          }
          expect(reply.text.replace(/\s+/gu, " ")).toContain(output.replace(/\s+/gu, " "));
          ownerResults[action] = "succeeded";
        }
        expect(managementAuditEvents()).toHaveLength(2);

        const sessionKey = `agent:qa:dashboard:automation-management-${randomUUID()}`;
        await gateway.call("sessions.create", {
          key: sessionKey,
          label: "Manage Telegram reminder",
        });
        const adminResults: Record<string, string> = {};
        let observedCronRuns: string | undefined;
        await suite.withPage(
          {
            locale: "en-US",
            ...(captureUiProof
              ? { recordVideo: { dir: proofDir, size: { width: 1280, height: 900 } } }
              : {}),
            viewport: { width: 1280, height: 900 },
            serviceWorkers: "block",
          },
          async ({ page }) => {
            await page.addInitScript(
              ({ gatewayUrl, token }) => {
                (
                  window as Window & {
                    __OPENCLAW_NATIVE_CONTROL_AUTH__?: { gatewayUrl: string; token: string };
                  }
                )["__OPENCLAW_NATIVE_CONTROL_AUTH__"] = { gatewayUrl, token };
              },
              { gatewayUrl: gateway.wsUrl, token: gateway.token },
            );
            await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
            for (const action of actions) {
              const marker = `admin-${action}`;
              provider.requests.set(marker, managementArgs(action, jobId));
              await page
                .locator(".agent-chat__composer-combobox textarea")
                .fill(`${action} the Telegram-created reminder. [automation-proof:${marker}]`);
              if (captureUiProof) {
                await page.screenshot({ path: path.join(proofDir, `${marker}-request.png`) });
              }
              await page.getByRole("button", { name: "Send message" }).click();
              try {
                await expect
                  .poll(() => provider.results.has(marker), { timeout: 60_000 })
                  .toBe(true);
              } catch (error) {
                throw new Error(
                  `Automation ${marker} did not complete: ${JSON.stringify({
                    completed: Object.keys(adminResults),
                    toolAvailability: [...provider.toolAvailability],
                    results: [...provider.results.keys()],
                    observations: provider.observations,
                  })}`,
                  { cause: error },
                );
              }
              const result = readResult(provider.results.get(marker) ?? "null");
              if (action === "list") {
                expect(result.jobs).toEqual(
                  expect.arrayContaining([expect.objectContaining({ id: jobId })]),
                );
              } else if (action === "get") {
                expect(result).toMatchObject({ id: jobId, name: automationName });
              } else if (action === "update") {
                const updatedJob = {
                  id: jobId,
                  name: "Reminder updated from Control UI",
                  payload: { ...creatorPayload, message: updatedReminderMessage },
                  owner: created.owner,
                  scheduledToolPolicy: created.scheduledToolPolicy,
                };
                expect(result).toEqual(expect.objectContaining(updatedJob));
                expect(await gateway.call("cron.get", { id: jobId })).toEqual(
                  expect.objectContaining(updatedJob),
                );
              } else if (action === "run") {
                expect(result).toMatchObject({ ok: true, enqueued: true });
                await expect
                  .poll(
                    async () => {
                      const runs = await gateway.call("cron.runs", { id: jobId });
                      observedCronRuns = redactQaGatewayDebugText(JSON.stringify(runs));
                      return {
                        succeeded:
                          isRecord(runs) &&
                          Array.isArray(runs.entries) &&
                          runs.entries.some((entry) => isRecord(entry) && entry.status === "ok"),
                        runs: observedCronRuns,
                      };
                    },
                    { timeout: 60_000 },
                  )
                  .toMatchObject({ succeeded: true });
              } else {
                expect(result).toMatchObject({ removed: true });
              }
              await page
                .getByText(new RegExp(`^${marker}:`, "u"))
                .first()
                .waitFor();
              if (captureUiProof) {
                await page.screenshot({ path: path.join(proofDir, `${marker}-result.png`) });
              }
              adminResults[action] = "succeeded";
            }
          },
        );
        const auditEvents = managementAuditEvents();
        expect(auditEvents).toHaveLength(actions.length + 2);
        await writeFile(
          path.join(proofDir, "verdict.json"),
          `${JSON.stringify(
            {
              gateway: "real isolated Gateway",
              channel: "real Telegram plugin with synthetic Crabline Bot API",
              provider: "deterministic local Responses API",
              creator: "Telegram conversation",
              admin: adminResults,
              cronRuns: observedCronRuns,
              configuredTelegramOwner: ownerResults,
              nonOwnerTelegramConversation: {
                automationsAvailable: provider.toolAvailability.get(nonOwnerMarker),
                remove: "unavailable visibly; job and runs unchanged",
              },
              adminManagementAuditEvents: auditEvents.length,
            },
            null,
            2,
          )}\n`,
        );
      } catch (error) {
        errors.push(error);
      }
      const stopped = await owner.stop({ preserveToDir: path.join(proofDir, "gateway") });
      errors.push(...stopped.errors);
      for (const stop of [() => transport.cleanupAfterGatewayStop(), () => provider.stop()]) {
        try {
          await stop();
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length) {
        throw new AggregateError(errors, "Cross-channel automation management proof failed");
      }
    },
  );
});
