import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { runQaGatewayFixture, stopQaGatewayFixture } from "openclaw/plugin-sdk/test-env";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import { createControlUiE2eSuite } from "../../../ui/src/e2e/control-ui-e2e-suite.test-support.ts";
import { controlUiSessionUrl } from "../../../ui/src/test-helpers/control-ui-e2e.ts";
import { createQaCrablineTransportAdapter } from "./crabline-transport.ts";
import { createQaGatewayChild, type QaGatewayChild } from "./gateway-child.ts";
import { redactQaGatewayDebugText } from "./gateway-log-redaction.ts";
import { isQaPosixProcessGroupAlive, signalQaPosixProcessGroup } from "./posix-process-group.ts";
import { hasToolDefinition } from "./providers/mock-openai/mock-openai-directives.ts";
import { buildAssistantEvents } from "./providers/mock-openai/mock-openai-events.ts";
import {
  extractLastUserText,
  extractToolOutput,
  hasToolOutput,
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
const toolPolicy = { profile: "full" as const, allow: ["automations", "session_status"] };
const screenshot = (page: Page, name: string) =>
  captureUiProof
    ? page.screenshot({ path: path.join(suite.artifactDir, `${name}.png`) })
    : Promise.resolve();
const poll = <T>(read: () => T | Promise<T>, timeout = 60_000) => expect.poll(read, { timeout });
const waitForReply = (page: Page, marker: string) =>
  page
    .getByText(new RegExp(`^${marker}:`, "u"))
    .first()
    .waitFor();
const makeRestartCheckpoint = (marker: string) => ({ marker, recovering: false, reached: false });

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
  let restartHold: ReturnType<typeof makeRestartCheckpoint> | undefined;
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
      const args = marker ? requests.get(marker) : undefined;
      const output = extractToolOutput(input);
      const hasOutput = hasToolOutput(input);
      const toolAvailable = hasToolDefinition(body, "automations");
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
    holdInitialRequestForRestart(marker: string) {
      return (restartHold = makeRestartCheckpoint(marker));
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
  const args = { action, ...(action === "list" ? { includeDisabled: true } : { jobId }) };
  if (action === "update") {
    return {
      ...args,
      job: {
        name: "Reminder updated from Control UI",
        payload: { message: updatedReminderMessage },
      },
    };
  }
  return action === "run" ? { ...args, runMode: "force" } : args;
}

function disabledJob(name: string, message: string) {
  return {
    action: "add",
    job: {
      name,
      enabled: false,
      schedule: { kind: "every", everyMs: 3_600_000 },
      sessionTarget: "isolated",
      payload: { kind: "agentTurn", message },
      delivery: { mode: "none" },
    },
  };
}

function startGateway(
  owner: ReturnType<typeof createQaGatewayChild>,
  providerBaseUrl: string,
  transport?: Awaited<ReturnType<typeof createQaCrablineTransportAdapter>>,
) {
  const repoRoot = process.cwd();
  return owner.start({
    repoRoot,
    command: {
      executablePath: process.execPath,
      argsPrefix: [path.join(repoRoot, "openclaw.mjs")],
      cwd: repoRoot,
      usePackagedPlugins: true,
    },
    providerMode: "mock-openai",
    providerBaseUrl,
    primaryModel: "mock-openai/gpt-5.6-luna",
    alternateModel: "mock-openai/gpt-5.6-luna-alt",
    forcedRuntime: "openclaw",
    transport,
    transportBaseUrl: "http://127.0.0.1",
    controlUiEnabled: false,
    controlUiAllowedOrigins: [new URL(suite.server.baseUrl).origin],
    mutateConfig: (cfg) => {
      if (transport) {
        // Admission includes a non-owner; automation authority still belongs to configured owners.
        cfg.commands = { ...cfg.commands, ownerAllowFrom: ["telegram:100001", "telegram:100002"] };
        cfg.session = { ...cfg.session, dmScope: "per-channel-peer" };
      }
      cfg.plugins = { ...cfg.plugins, slots: { ...cfg.plugins?.slots, memory: "none" } };
      cfg.memory = { ...cfg.memory, search: { ...cfg.memory?.search, enabled: false } };
      cfg.tools = {
        ...toolPolicy,
        codeMode: false,
        toolSearch: false,
        // Ordinary full-access recovery retains non-replay-safe automations.
        ...(!transport ? { exec: { mode: "full" as const } } : {}),
      };
      const entries = ((cfg.agents ??= {}).entries ??= {});
      entries.qa = {
        ...entries.qa,
        identity: { name: transport ? "Automation proof" : "Recovery proof" },
        tools: toolPolicy,
      };
      return cfg;
    },
  });
}

function withChat(gateway: QaGatewayChild, sessionKey: string, run: (page: Page) => Promise<void>) {
  return suite.withPage(
    {
      locale: "en-US",
      viewport: { width: 1280, height: 900 },
      serviceWorkers: "block",
      ...(captureUiProof
        ? { recordVideo: { dir: suite.artifactDir, size: { width: 1280, height: 900 } } }
        : {}),
    },
    async ({ page }) => {
      await page.addInitScript(
        (auth) => {
          Object.assign(window, { __OPENCLAW_NATIVE_CONTROL_AUTH__: auth });
        },
        { gatewayUrl: gateway.wsUrl, token: gateway.token },
      );
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
      await run(page);
    },
  );
}

const writeVerdict = (file: string, value: unknown) =>
  writeFile(path.join(suite.artifactDir, file), `${JSON.stringify(value, null, 2)}\n`);

const withAutomationGateway =
  (
    channel: boolean,
    run: (
      gateway: QaGatewayChild,
      provider: Awaited<ReturnType<typeof startAutomationProvider>>,
      transport?: Awaited<ReturnType<typeof createQaCrablineTransportAdapter>>,
    ) => Promise<void>,
  ) =>
  async () => {
    const provider = await startAutomationProvider();
    const owner = createQaGatewayChild();
    let acquiredTransport: Awaited<ReturnType<typeof createQaCrablineTransportAdapter>> | undefined;
    await runQaGatewayFixture(
      async () => {
        const transport = channel
          ? await createQaCrablineTransportAdapter({
              outputDir: suite.artifactDir,
              transportPolicy: { senderAllowlist: ["100001", "100002", "100003"] },
              selection: {
                channel: "telegram",
                channelDriver: "crabline",
                capabilityMatrixPath: "crabline-channel-driver-capabilities.json",
                providerReadinessArtifactPath: "crabline-provider-readiness.json",
              },
            })
          : undefined;
        acquiredTransport = transport;
        const gateway = await startGateway(owner, provider.baseUrl, transport);
        await transport?.waitReady({ gateway });
        await run(gateway, provider, transport);
      },
      () =>
        stopQaGatewayFixture(owner, {
          preserveToDir: path.join(suite.artifactDir, channel ? "gateway" : "recovery-gateway"),
        }),
      () => acquiredTransport?.cleanupAfterGatewayStop(),
      () => provider.stop(),
    );
  };

suite.define(() => {
  it.skipIf(process.platform === "win32")(
    "an ordinary Control UI turn creates a disabled automation after its Gateway is replaced",
    { timeout: 240_000 },
    withAutomationGateway(false, async (gateway, provider) => {
      const marker = "recovered-create";
      const checkpoint = provider.holdInitialRequestForRestart(marker);
      const jobName = "Disabled restart recovery proof";
      provider.requests.set(marker, disabledJob(jobName, "Synthetic disabled recovery reminder."));
      const sessionKey = `agent:qa:dashboard:operator-recovery-${randomUUID()}`;
      await gateway.call("sessions.create", {
        key: sessionKey,
        label: "Restart automation proof",
      });
      await withChat(gateway, sessionKey, async (page) => {
        const prompt = `Create one disabled hourly reminder after continuing this turn. [automation-proof:${marker}]`;
        await page.locator(".agent-chat__composer-combobox textarea").fill(prompt);
        await page.getByRole("button", { name: "Send message" }).click();
        await poll(() => checkpoint.reached).toBe(true);
        await poll(async () => {
          const entry = (await readRawQaSessionStore({ gateway }))[sessionKey];
          const transcript = await readSessionTranscriptSummary({ gateway }, sessionKey);
          return Boolean(entry?.restartRecoveryDeliveryRunId) && transcript.userMessageCount === 1;
        }, 30_000).toBe(true);
        expect(provider.results.has(marker)).toBe(false);
        const before = (await readRawQaSessionStore({ gateway }))[sessionKey];
        if (!before?.restartRecoveryDeliveryRunId) {
          throw new Error("Original Control UI admission lost its recovery claim");
        }
        const originalRunId = before.restartRecoveryDeliveryRunId;
        await screenshot(page, "recovery-before-restart");
        const originalPid = gateway.pid;
        if (originalPid === null) {
          throw new Error("Owned Gateway has no process identity");
        }
        // Replace the exact owned process group, not an operator service.
        // Startup reconciles the real chat admission; no claim is seeded.
        expect(signalQaPosixProcessGroup(originalPid, "SIGKILL")).toBeUndefined();
        await poll(() => isQaPosixProcessGroupAlive(originalPid), 30_000).toBe(false);
        checkpoint.recovering = true;
        await gateway.restartAfterStateMutation(async () => {});
        expect(gateway.pid).not.toBe(originalPid);
        await poll(() => provider.results.has(marker), 90_000).toBe(true);
        const created = readResult(provider.results.get(marker) ?? "null");
        expect(created).toMatchObject({ id: expect.any(String), name: jobName, enabled: false });
        expect(await gateway.call("cron.get", { id: String(created.id) })).toMatchObject({
          id: created.id,
          name: jobName,
          enabled: false,
          owner: { sessionKey },
        });
        await poll(async () => {
          const after = (await readRawQaSessionStore({ gateway }))[sessionKey];
          return {
            sessionId: after?.sessionId,
            status: after?.status,
            originalTurnSettled: after?.restartRecoveryTerminalRunIds?.includes(originalRunId),
            recoveryClaimCleared: after?.restartRecoveryDeliveryRunId === undefined,
          };
        }, 30_000).toEqual({
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
        const originalInputs = history.messages.filter(isRecord).filter(
          ({ role, content }) =>
            role === "user" &&
            (typeof content === "string"
              ? content
              : Array.isArray(content)
                ? content
                    .filter(isRecord)
                    .filter((block) => block.type === "text" && typeof block.text === "string")
                    .map((block) => block.text)
                    .join("\n")
                : undefined) === prompt,
        );
        expect(originalInputs).toHaveLength(1);
        await waitForReply(page, marker);
        await screenshot(page, "recovery-created-disabled-automation");
        await writeVerdict("recovery-verdict.json", {
          originalUserTurns: 1,
          automation: { name: created.name, enabled: created.enabled, persisted: true },
        });
      });
    }),
  );
  it(
    "configured owners and admin chat manage a Telegram-created job while a non-owner cannot",
    { timeout: 240_000 },
    withAutomationGateway(true, async (gateway, provider, transport) => {
      if (!transport) {
        throw new Error("Telegram management proof requires its transport");
      }
      const send = (senderId: string, marker: string, text: string) =>
        transport.sendInbound({
          accountId: transport.accountId,
          conversation: { id: senderId, kind: "direct" },
          senderId,
          text: `${text} [automation-proof:${marker}]`,
        });
      provider.requests.set(
        "create",
        disabledJob(automationName, "Complete this synthetic reminder."),
      );
      await send("100001", "create", "Create a disabled hourly reminder.");
      await transport.waitForOutbound({ textIncludes: "create:", timeoutMs: 60_000 });
      const created = readResult(provider.results.get("create") ?? "null");
      expect(created).toMatchObject({
        id: expect.any(String),
        name: automationName,
        owner: { sessionKey: expect.stringContaining(":telegram:") },
        scheduledToolPolicy: { mode: "account" },
        payload: { kind: "agentTurn", toolsAllow: ["*"] },
      });
      if (!isRecord(created.payload)) {
        throw new Error("Created automation has no payload");
      }
      const creatorPayload = created.payload;
      const jobId = String(created.id);
      const updatedJob = {
        id: jobId,
        name: "Reminder updated from Control UI",
        payload: { ...creatorPayload, message: updatedReminderMessage },
        owner: created.owner,
        scheduledToolPolicy: created.scheduledToolPolicy,
      };
      const expectedResults = {
        list: { jobs: expect.arrayContaining([expect.objectContaining({ id: jobId })]) },
        get: { id: jobId, name: automationName },
        update: updatedJob,
        run: { ok: true, enqueued: true },
        remove: { removed: true },
      };
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
      await send("100003", nonOwnerMarker, "Remove the other conversation's reminder.");
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
        await send("100002", marker, "Manage the other conversation's reminder.");
        const reply = await transport.waitForOutbound({
          textIncludes: `${marker}:`,
          sinceIndex: outboundIndex,
          timeoutMs: 60_000,
        });
        const output = provider.results.get(marker) ?? "";
        expect(provider.toolAvailability.get(marker)).toBe(true);
        expect(readResult(output)).toEqual(expect.objectContaining(expectedResults[action]));
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
      await withChat(gateway, sessionKey, async (page) => {
        for (const action of actions) {
          const marker = `admin-${action}`;
          provider.requests.set(marker, managementArgs(action, jobId));
          await page
            .locator(".agent-chat__composer-combobox textarea")
            .fill(`${action} the Telegram-created reminder. [automation-proof:${marker}]`);
          await screenshot(page, `${marker}-request`);
          await page.getByRole("button", { name: "Send message" }).click();
          await poll(() => provider.results.has(marker)).toBe(true);
          const result = readResult(provider.results.get(marker) ?? "null");
          expect(result).toEqual(expect.objectContaining(expectedResults[action]));
          if (action === "update") {
            expect(await gateway.call("cron.get", { id: jobId })).toEqual(
              expect.objectContaining(updatedJob),
            );
          } else if (action === "run") {
            await poll(async () => {
              const runs = await gateway.call("cron.runs", { id: jobId });
              observedCronRuns = redactQaGatewayDebugText(JSON.stringify(runs));
              return {
                succeeded:
                  isRecord(runs) &&
                  Array.isArray(runs.entries) &&
                  runs.entries.some((entry) => isRecord(entry) && entry.status === "ok"),
                runs: observedCronRuns,
              };
            }).toMatchObject({ succeeded: true });
          }
          await waitForReply(page, marker);
          await screenshot(page, `${marker}-result`);
          adminResults[action] = "succeeded";
        }
      });
      const auditEvents = managementAuditEvents();
      expect(auditEvents).toHaveLength(actions.length + 2);
      await writeVerdict("verdict.json", {
        admin: adminResults,
        cronRuns: observedCronRuns,
        configuredTelegramOwner: ownerResults,
        nonOwnerTelegramConversation: {
          automationsAvailable: provider.toolAvailability.get(nonOwnerMarker),
        },
        adminManagementAuditEvents: auditEvents.length,
      });
    }),
  );
});
