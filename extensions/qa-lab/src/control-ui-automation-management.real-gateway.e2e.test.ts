import { randomUUID } from "node:crypto";
import path from "node:path";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { runQaGatewayFixture, stopQaGatewayFixture } from "openclaw/plugin-sdk/test-env";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import { createControlUiE2eSuite } from "../../../ui/src/e2e/control-ui-e2e-suite.test-support.ts";
import { controlUiSessionUrl } from "../../../ui/src/test-helpers/control-ui-e2e.ts";
import { startAutomationProvider } from "./control-ui-automation-provider.test-support.ts";
import {
  authenticateControlUi,
  captureControlUi,
  controlUiPageOptions,
} from "./control-ui-gateway.e2e.test-support.ts";
import { createQaCrablineTransportAdapter } from "./crabline-transport.ts";
import { createQaGatewayChild, type QaGatewayChild } from "./gateway-child.ts";
import { isQaPosixProcessGroupAlive, signalQaPosixProcessGroup } from "./posix-process-group.ts";
import {
  readRawQaSessionStore,
  readSessionTranscriptSummary,
} from "./suite-runtime-agent-session.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI cross-channel automation management with a real Gateway",
  startServerBeforeBrowser: true,
});

type AutomationAction = "list" | "get" | "update" | "run" | "remove";
const actions = ["list", "get", "update", "run", "remove"] as const;
const automationName = "Telegram-created reminder _literal_";
const updatedReminderMessage = "Complete the reminder updated from Control UI.";
const toolPolicy = { profile: "full" as const, allow: ["automations", "session_status"] };
const screenshot = (page: Page, name: string) =>
  captureControlUi(page, suite.artifactDir, `${name}.png`);
const poll = <T>(read: () => T | Promise<T>, timeout = 60_000) => expect.poll(read, { timeout });
const waitForReply = (page: Page, marker: string) =>
  page
    .getByText(new RegExp(`^${marker}:`, "u"))
    .first()
    .waitFor();

function readResult(text: string): Record<string, unknown> {
  const value: unknown = JSON.parse(text);
  if (!isRecord(value)) {
    throw new Error("Automation tool returned no object result");
  }
  return value;
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
      // Repository fixtures stage auth directly; packaged bootstrap has dedicated coverage.
      usePackagedPlugins: false,
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
      const agent = (entries.qa ??= {});
      agent.identity = { name: transport ? "Automation proof" : "Recovery proof" };
      agent.tools = toolPolicy;
      return cfg;
    },
  });
}

function withChat(gateway: QaGatewayChild, sessionKey: string, run: (page: Page) => Promise<void>) {
  return suite.withPage(controlUiPageOptions(suite.artifactDir), async ({ page }) => {
    await authenticateControlUi(page, gateway);
    await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
    await run(page);
  });
}

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
      const jobBeforeNonOwner = await gateway.call("cron.get", { id: jobId });
      const runsBeforeNonOwner = await gateway.call("cron.runs", { id: jobId });
      const nonOwnerMarker = "non-owner-remove";
      provider.requests.set(nonOwnerMarker, managementArgs("remove", jobId));
      await send("100003", nonOwnerMarker, "Remove the other conversation's reminder.");
      const nonOwnerReply = await transport.waitForOutbound({
        textIncludes: `${nonOwnerMarker}:`,
        timeoutMs: 60_000,
      });
      // The definition stays visible for prompt caching; execution requires owner authority.
      const nonOwnerRefusal =
        "automations needs the owner's authority, and this turn was not started by the owner. Do not retry automations.";
      expect(provider.toolAvailability.get(nonOwnerMarker)).toBe(true);
      expect(provider.results.get(nonOwnerMarker)).toBe(nonOwnerRefusal);
      expect(nonOwnerReply.text).toContain(nonOwnerRefusal);
      expect(await gateway.call("cron.get", { id: jobId })).toEqual(jobBeforeNonOwner);
      expect(await gateway.call("cron.runs", { id: jobId })).toEqual(runsBeforeNonOwner);
      expect(managementAuditEvents()).toHaveLength(0);

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
      }
      const sessionKey = `agent:qa:dashboard:automation-management-${randomUUID()}`;
      await gateway.call("sessions.create", {
        key: sessionKey,
        label: "Manage Telegram reminder",
      });
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
              return (
                isRecord(runs) &&
                Array.isArray(runs.entries) &&
                runs.entries.some((entry) => isRecord(entry) && entry.status === "ok")
              );
            }).toBe(true);
          }
          await waitForReply(page, marker);
          // Persisted replies can precede the browser's terminal event.
          await page.getByRole("button", { name: "Stop generating", exact: true }).waitFor({
            state: "hidden",
          });
          await screenshot(page, `${marker}-result`);
        }
      });
      // Both configured-owner reads and removal's revision lookup are audited.
      expect(managementAuditEvents()).toHaveLength(actions.length + 3);
    }),
  );
});
