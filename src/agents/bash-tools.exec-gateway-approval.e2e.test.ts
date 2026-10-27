import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { asNonArrayRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GATEWAY_CLIENT_CAPS } from "../../packages/gateway-protocol/src/client-info.js";
import { buildCommandExecApprovalDefaults } from "../auto-reply/reply/commands-private-route.js";
import { buildCommandTestParams } from "../auto-reply/reply/commands.test-harness.js";
import { clearConfigCache, clearRuntimeConfigSnapshot } from "../config/config.js";
import { clearSessionStoreCacheForTest } from "../config/sessions/store-writer-state.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { ADMIN_SCOPE, APPROVALS_SCOPE } from "../gateway/method-scopes.js";
import { startGatewayServer } from "../gateway/server.js";
import { connectGatewayClient, disconnectGatewayClient } from "../gateway/test-helpers.e2e.js";
import { GATEWAY_STARTUP_MUTATED_ENV_KEYS } from "../gateway/test-helpers.env.js";
import {
  acquireGatewayE2ePortBlock,
  startClaimedGateway,
} from "../gateway/test-helpers.listener.js";
import { loadOrCreateDeviceIdentity } from "../infra/device-identity.js";
import { withTimeout } from "../infra/fs-safe.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createDeferredCore } from "../shared/deferred.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import { createOpenClawCodingTools } from "./agent-tools.js";
import { getFinishedSession } from "./bash-process-registry.js";
import { resetProcessRegistryForTests } from "./bash-process-registry.test-support.js";
import type {
  ExecApprovalFollowupFactory,
  ExecApprovalFollowupOutcome,
} from "./bash-tools.exec-types.js";
import { createExecTool } from "./bash-tools.js";

const TEST_ENV_KEYS = [
  "HOME",
  ...GATEWAY_STARTUP_MUTATED_ENV_KEYS,
  "OPENCLAW_STATE_DIR",
  "OPENCLAW_CONFIG_PATH",
  "OPENCLAW_GATEWAY_TOKEN",
  "OPENCLAW_SKIP_CHANNELS",
  "OPENCLAW_SKIP_GMAIL_WATCHER",
  "OPENCLAW_SKIP_CRON",
  "OPENCLAW_SKIP_CANVAS_HOST",
  "OPENCLAW_SKIP_BROWSER_CONTROL_SERVER",
  "OPENCLAW_SKIP_PROVIDERS",
  "OPENCLAW_TEST_MINIMAL_GATEWAY",
];
const GATEWAY_CONNECT_TIMEOUT_MS = 120_000;
const EXEC_APPROVAL_E2E_TIMEOUT_MS = 180_000;

type Cleanup = () => Promise<void> | void;

function requireApprovalId(details: unknown): string {
  const record = asNonArrayRecord(details);
  if (record?.status !== "approval-pending" || typeof record.approvalId !== "string") {
    throw new Error("expected approval-pending exec result");
  }
  return record.approvalId;
}

function scheduledExec(
  config: OpenClawConfig,
  workspaceDir: string,
  approvalFollowup: ExecApprovalFollowupFactory,
) {
  return expectDefined(
    createOpenClawCodingTools({
      agentId: "main",
      config,
      workspaceDir,
      cwd: workspaceDir,
      sessionPermissionPolicy: { root: workspaceDir, mode: "full" },
      scheduledToolPolicy: {
        version: 1,
        mode: "trusted",
        execTarget: { host: "gateway", ask: "always" },
      },
      exec: { approvalRunningNoticeMs: 0, approvalFollowupMode: "direct", approvalFollowup },
    }).find((candidate) => candidate.name === "exec"),
    "scheduled exec tool",
  );
}

const approvedOutcome = (promise: Promise<ExecApprovalFollowupOutcome>) =>
  withTimeout(promise, 15_000, { message: "timed out waiting for approved exec outcome" });

describe("gateway-hosted exec approvals", () => {
  const cleanup: Cleanup[] = [];

  afterEach(async () => {
    for (const step of cleanup.splice(0).toReversed()) {
      await step();
    }
    clearRuntimeConfigSnapshot();
    clearConfigCache();
    clearSessionStoreCacheForTest();
    resetProcessRegistryForTests();
  });

  async function startApprovalGateway(
    buildConfig: (workspaceDir: string) => Partial<OpenClawConfig>,
    options: { extraEnvKeys?: string[]; configReload?: boolean } = {},
  ) {
    const extraEnvKeys = options.extraEnvKeys ?? [];
    const envSnapshot = captureEnv([...TEST_ENV_KEYS, ...extraEnvKeys]);
    cleanup.push(() => envSnapshot.restore());

    const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-exec-approval-e2e-"));
    cleanup.push(() => fs.rm(tempHome, { recursive: true, force: true, maxRetries: 5 }));

    const stateDir = path.join(tempHome, ".openclaw");
    const workspaceDir = path.join(tempHome, "workspace");
    await fs.mkdir(workspaceDir, { recursive: true });

    const token = "exec-approval-e2e-token";
    const configPath = path.join(stateDir, "openclaw.json");
    await fs.mkdir(stateDir, { recursive: true });
    const claim = await acquireGatewayE2ePortBlock();
    const config: OpenClawConfig = {
      agents: {
        ownership: "explicit",
        defaults: { workspace: workspaceDir },
        entries: { main: {} },
      },
      gateway: { port: claim.port, auth: { mode: "token", token } },
      tools: { exec: { host: "gateway", security: "full", ask: "off" } },
      ...buildConfig(workspaceDir),
    };
    const server = await startClaimedGateway(claim, async () => {
      await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");

      setTestEnvValue("HOME", tempHome);
      setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
      setTestEnvValue("OPENCLAW_CONFIG_PATH", configPath);
      setTestEnvValue("OPENCLAW_GATEWAY_TOKEN", token);
      setTestEnvValue("OPENCLAW_GATEWAY_PORT", String(claim.port));
      setTestEnvValue("OPENCLAW_SKIP_CHANNELS", "1");
      setTestEnvValue("OPENCLAW_SKIP_GMAIL_WATCHER", "1");
      setTestEnvValue("OPENCLAW_SKIP_CRON", "1");
      setTestEnvValue("OPENCLAW_SKIP_CANVAS_HOST", "1");
      setTestEnvValue("OPENCLAW_SKIP_BROWSER_CONTROL_SERVER", "1");
      setTestEnvValue("OPENCLAW_SKIP_PROVIDERS", "1");
      // The minimal test Gateway skips the managed config reloader that config.patch needs.
      setTestEnvValue("OPENCLAW_TEST_MINIMAL_GATEWAY", options.configReload ? "0" : "1");
      clearRuntimeConfigSnapshot();
      clearConfigCache();
      clearSessionStoreCacheForTest();

      // Shared channel stubs make post-connect health checks load unrelated channel runtimes.
      setActivePluginRegistry(createEmptyPluginRegistry());
      return await startGatewayServer(claim.port, {
        bind: "loopback",
        auth: { mode: "token", token },
        controlUiEnabled: false,
        sidecarStartup: "defer",
      });
    });
    cleanup.push(() => server.close());

    const connect = async (clientDisplayName: string, reviewer?: string) => {
      const deviceIdentity = reviewer
        ? loadOrCreateDeviceIdentity({
            path: path.join(
              stateDir,
              "test-device-identities",
              reviewer,
              "client",
              "credentials.sqlite",
            ),
          })
        : undefined;
      const client = await connectGatewayClient({
        url: `ws://127.0.0.1:${claim.port}`,
        token,
        clientDisplayName,
        deviceIdentity,
        clientName: GATEWAY_CLIENT_NAMES.TEST,
        mode: GATEWAY_CLIENT_MODES.TEST,
        scopes: [reviewer ? APPROVALS_SCOPE : ADMIN_SCOPE],
        caps: [GATEWAY_CLIENT_CAPS.EXEC_APPROVALS],
        requestTimeoutMs: GATEWAY_CONNECT_TIMEOUT_MS,
        timeoutMs: GATEWAY_CONNECT_TIMEOUT_MS,
      });
      cleanup.push(() => disconnectGatewayClient(client));
      return { client, deviceIdentity };
    };
    const { client: operator } = await connect("approval operator");
    return { config, configPath, operator, connect, port: claim.port, workspaceDir };
  }

  it(
    "keeps a scheduled approval floor in a reused full-permission session",
    async () => {
      const { config, operator, connect, workspaceDir } = await startApprovalGateway(
        (workspace) => ({
          agents: {
            ownership: "explicit",
            defaults: { workspace },
            entries: {
              main: { tools: { exec: { cleanupMs: 180_000 } } },
              helper: {},
            },
          },
          tools: {
            exec: {
              host: "gateway",
              security: "full",
              ask: "off",
              cleanupMs: 60_000,
            },
          },
        }),
      );

      const { client: originReviewer, deviceIdentity } = await connect(
        "origin approval reviewer",
        "origin-reviewer",
      );
      const { client: otherReviewer } = await connect("other approval reviewer", "other-reviewer");
      const allowed = createDeferredCore<ExecApprovalFollowupOutcome>();
      let approvedProcessId: string | undefined;
      let resolveOutcome: (outcome: ExecApprovalFollowupOutcome) => void = () => {};
      const tool = scheduledExec(config, workspaceDir, ({ outcome, sessionId }) => {
        approvedProcessId = sessionId;
        resolveOutcome(outcome);
        return undefined;
      });

      const markerPath = path.join(workspaceDir, "denied-marker");
      const deniedPending = await tool.execute("exec-approval-e2e-denied", {
        command: `touch ${JSON.stringify(markerPath)}`,
        workdir: workspaceDir,
        timeoutSeconds: 5,
      });
      const deniedApprovalId = requireApprovalId(deniedPending.details);
      await operator.request(
        "exec.approval.resolve",
        { id: deniedApprovalId, decision: "deny" },
        { timeoutMs: 10_000 },
      );
      await expect(fs.stat(markerPath)).rejects.toMatchObject({ code: "ENOENT" });

      resolveOutcome = allowed.resolve;

      const pending = await tool.execute("exec-approval-e2e", {
        command: "printf 'smoke\\n'",
        workdir: workspaceDir,
        timeoutSeconds: 5,
      });
      const approvalId = requireApprovalId(pending.details);

      const helperTools = createOpenClawCodingTools({ agentId: "helper", config, workspaceDir });
      const helperProcess = expectDefined(
        helperTools.find((candidate) => candidate.name === "process"),
        "helper process tool",
      );
      await helperProcess.execute("helper-process-during-approval", { action: "list" });

      await operator.request(
        "exec.approval.resolve",
        { id: approvalId, decision: "allow-once" },
        { timeoutMs: 10_000 },
      );

      expect(await approvedOutcome(allowed.promise)).toMatchObject({
        status: "completed",
        exitCode: 0,
        aggregated: "smoke",
      });
      const finished = expectDefined(
        getFinishedSession(expectDefined(approvedProcessId, "approved process identity")),
        "retained approved process output",
      );
      expect(finished.expiresAt - finished.endedAt).toBe(180_000);

      const {
        messageProvider,
        currentChannelId,
        currentThreadTs,
        accountId,
        approvalReviewerDeviceId,
      } = buildCommandExecApprovalDefaults(
        buildCommandTestParams(
          "/diagnostics",
          config,
          {
            Provider: "webchat",
            Surface: "webchat",
            From: "owner",
            To: "owner",
            ApprovalReviewerDeviceId: expectDefined(deviceIdentity, "origin reviewer identity")
              .deviceId,
            OriginatingTo: "owner",
          },
          { workspaceDir },
        ),
      );
      const routed = createDeferredCore<ExecApprovalFollowupOutcome>();
      const routedTool = createExecTool({
        host: "gateway",
        security: "allowlist",
        ask: "always",
        allowBackground: true,
        approvalRunningNoticeMs: 0,
        approvalFollowupMode: "direct",
        approvalFollowup: ({ outcome: routedOutcome }) => {
          routed.resolve(routedOutcome);
          return undefined;
        },
        cwd: workspaceDir,
        agentId: "main",
        sessionKey: "agent:main:main",
        messageProvider,
        currentChannelId,
        currentThreadTs,
        accountId,
        approvalReviewerDeviceId,
      });
      const routedPending = await routedTool.execute("exec-approval-device-custody", {
        command: "printf 'device-bound-smoke\\n'",
        workdir: workspaceDir,
        background: true,
        timeoutSeconds: 5,
      });
      const routedApprovalId = requireApprovalId(routedPending.details);

      await expect(
        otherReviewer.request(
          "exec.approval.resolve",
          { id: routedApprovalId, decision: "allow-once" },
          { timeoutMs: 10_000 },
        ),
      ).rejects.toThrow("unknown or expired approval id");
      await originReviewer.request(
        "exec.approval.resolve",
        { id: routedApprovalId, decision: "allow-once" },
        { timeoutMs: 10_000 },
      );

      expect(await approvedOutcome(routed.promise)).toMatchObject({
        status: "completed",
        exitCode: 0,
        aggregated: "device-bound-smoke",
      });
    },
    EXEC_APPROVAL_E2E_TIMEOUT_MS,
  );

  it(
    "withholds the active hook token source from exec children at startup and across reload",
    async () => {
      const oldName = "OPENCLAW_E2E_HOOK_SOURCE_OLD";
      const newName = "OPENCLAW_E2E_HOOK_SOURCE_NEW";
      const oldValue = "synthetic-old-hook-ingress-value";
      const newValue = "synthetic-new-hook-ingress-value";
      const { config, configPath, operator, port, workspaceDir } = await startApprovalGateway(
        () => {
          setTestEnvValue(oldName, oldValue);
          setTestEnvValue(newName, newValue);
          return {
            hooks: { enabled: true, token: `\${${oldName}}` },
          };
        },
        { extraEnvKeys: [oldName, newName], configReload: true },
      );
      // An empty wake text fails validation after authentication (400) while a rejected
      // bearer stops at 401, so the probe checks ingress auth without enqueueing a wake.
      const wake = async (bearer: string) =>
        (
          await fetch(`http://127.0.0.1:${port}/hooks/wake`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${bearer}` },
            body: JSON.stringify({ text: "", mode: "next-heartbeat" }),
          })
        ).status;

      let resolveOutcome: (outcome: ExecApprovalFollowupOutcome) => void = () => {};
      const tool = scheduledExec(config, workspaceDir, ({ outcome }) => {
        resolveOutcome(outcome);
        return undefined;
      });
      const queue = async (id: string, command = "env") => {
        const outcome = new Promise<ExecApprovalFollowupOutcome>((resolve) => {
          resolveOutcome = resolve;
        });
        const pending = await tool.execute(id, {
          command,
          workdir: workspaceDir,
          timeoutSeconds: 5,
        });
        return { id, approvalId: requireApprovalId(pending.details), outcome };
      };
      const allowOnce = (approvalId: string) =>
        operator.request(
          "exec.approval.resolve",
          { id: approvalId, decision: "allow-once" },
          { timeoutMs: 10_000 },
        );
      const approve = async (queued: Awaited<ReturnType<typeof queue>>) => {
        await allowOnce(queued.approvalId);
        const outcome = await approvedOutcome(queued.outcome);
        expect(outcome.status).toBe("completed");
        const inherited = new Set(outcome.aggregated.split("\n").map((line) => line.split("=")[0]));
        return [oldName, newName].filter((name) => inherited.has(name));
      };

      // Startup: hook ingress accepts the referenced value; exec children never see it.
      await vi.waitFor(async () => expect(await wake(oldValue)).toBe(400), {
        timeout: 15_000,
        interval: 500,
      });
      expect(await wake(newValue)).toBe(401);
      expect(await approve(await queue("hook-token-startup"))).toEqual([newName]);

      // An approval still pending when hooks.token is reloaded to another env name.
      const markerPath = path.join(workspaceDir, "queued-across-reload");
      const queued = await queue("hook-token-queued", `touch ${JSON.stringify(markerPath)}`);
      await fs.writeFile(
        configPath,
        `${JSON.stringify({ ...config, hooks: { enabled: true, token: `\${${newName}}` } }, null, 2)}\n`,
        "utf8",
      );
      await vi.waitFor(async () => expect(await wake(newValue)).toBe(400), {
        timeout: 15_000,
        interval: 500,
      });
      await allowOnce(queued.approvalId);

      // After reload: ingress follows the new name and only that name is withheld.
      expect(await approve(await queue("hook-token-after-reload"))).toEqual([oldName]);
      expect(await wake(newValue)).toBe(400);
      expect(await wake(oldValue)).toBe(401);
      // The reload fenced the pending approval wait, so the queued command never launched.
      await expect(fs.stat(markerPath)).rejects.toMatchObject({ code: "ENOENT" });
    },
    EXEC_APPROVAL_E2E_TIMEOUT_MS,
  );
});
