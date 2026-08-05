/**
 * Gateway e2e proof for the exec-approval origin-authorization ticket
 * (UPSTREAM #115933): a channel that was never in the shipped catalog can
 * still reach `isNativeApprovalChannel()` through the bundled-plugin-catalog
 * test seam (see `test/plugin-cron-registry-owner.e2e.test.ts`), and the
 * real per-message sender id a channel plugin's inbound event carries
 * (`SenderFacts.id` on `buildChannelInboundEventContext`) really does reach
 * `turnSourceSenderId` on the exec tool and change approval behavior.
 *
 * Two routes, one fixture channel, one gateway:
 *  - an unauthorized sender's turn falls back to the async approval-pending
 *    path (identical to a channel with no native approval UI at all);
 *  - an authorized sender's turn waits inline and returns the real exec
 *    output, exactly like the Telegram/Discord native-approval UX PR #85239
 *    fixed.
 *
 * No product code changed to make this observable: the fixture channel is a
 * plugin loaded through `OPENCLAW_BUNDLED_PLUGINS_DIR`, registered with the
 * public `api.registerChannel` plugin-sdk surface, exactly like a real
 * channel package.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GATEWAY_CLIENT_CAPS } from "../../packages/gateway-protocol/src/client-info.js";
import { buildChannelInboundEventContext } from "../channels/inbound-event/context.js";
import { clearConfigCache, clearRuntimeConfigSnapshot } from "../config/config.js";
import { clearSessionStoreCacheForTest } from "../config/sessions/store-writer-state.js";
import { ADMIN_SCOPE } from "../gateway/method-scopes.js";
import { startGatewayServer } from "../gateway/server.js";
import {
  connectGatewayClient,
  disconnectGatewayClient,
  getFreeGatewayPort,
} from "../gateway/test-helpers.e2e.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import { withTimeout } from "../utils/with-timeout.js";
import { createExecTool } from "./bash-tools.exec-run.js";

const FIXTURE_CHANNEL_ID = "exec-approval-fixture-channel";
const PLUGIN_ID = "exec-approval-channel-sender-routing-proof";
const AUTHORIZED_SENDER_ID = "authorized-operator";
const UNAUTHORIZED_SENDER_ID = "someone-else";

const TEST_ENV_KEYS = [
  "HOME",
  "OPENCLAW_STATE_DIR",
  "OPENCLAW_CONFIG_PATH",
  "OPENCLAW_GATEWAY_TOKEN",
  "OPENCLAW_GATEWAY_PORT",
  "OPENCLAW_BUNDLED_PLUGINS_DIR",
  "OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR",
  "OPENCLAW_SKIP_CHANNELS",
  "OPENCLAW_SKIP_GMAIL_WATCHER",
  "OPENCLAW_SKIP_CRON",
  "OPENCLAW_SKIP_CANVAS_HOST",
  "OPENCLAW_SKIP_BROWSER_CONTROL_SERVER",
  "OPENCLAW_SKIP_PROVIDERS",
];
const GATEWAY_CONNECT_TIMEOUT_MS = 120_000;
const EXEC_APPROVAL_E2E_TIMEOUT_MS = 180_000;

type Cleanup = () => Promise<void> | void;

/**
 * Writes a channel-registering plugin into a bundled-plugins directory the
 * same way `test/plugin-cron-registry-owner.e2e.test.ts` writes a
 * scheduler-registering one: an `openclaw.plugin.json` manifest for plugin
 * activation, an `index.js` that calls `api.registerChannel`, and (the part
 * that closes the ticket's open question) a `package.json` declaring
 * `openclaw.channel` with `approvalFlags: ["native"]` -- the file
 * `readBundledExtensionCatalogEntriesSync()` actually reads.
 */
async function writeBundledChannelPlugin(bundledRoot: string): Promise<void> {
  const pluginDir = path.join(bundledRoot, PLUGIN_ID);
  await mkdir(pluginDir, { recursive: true });
  await writeFile(
    path.join(pluginDir, "package.json"),
    `${JSON.stringify(
      {
        name: PLUGIN_ID,
        version: "0.0.0",
        openclaw: {
          channel: {
            id: FIXTURE_CHANNEL_ID,
            approvalFlags: ["native"],
          },
        },
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    path.join(pluginDir, "openclaw.plugin.json"),
    `${JSON.stringify(
      {
        id: PLUGIN_ID,
        activation: { onStartup: true },
        configSchema: { type: "object", additionalProperties: false, properties: {} },
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    path.join(pluginDir, "index.js"),
    `module.exports = {
  id: ${JSON.stringify(PLUGIN_ID)},
  register(api) {
    api.registerChannel({
      plugin: {
        id: ${JSON.stringify(FIXTURE_CHANNEL_ID)},
        meta: {
          id: ${JSON.stringify(FIXTURE_CHANNEL_ID)},
          label: "Exec Approval Fixture Channel",
          selectionLabel: "Exec Approval Fixture Channel",
          docsPath: "/channels/${FIXTURE_CHANNEL_ID}",
          blurb: "test fixture channel for exec-approval origin authorization proof",
        },
        capabilities: { chatTypes: ["direct"] },
        config: {
          listAccountIds: () => ["default"],
          resolveAccount: () => ({ enabled: true, configured: true }),
          isEnabled: () => true,
          describeAccount: () => ({ accountId: "default", enabled: true, configured: true }),
        },
        // Mirrors a real channel's same-chat approver allowlist: only the
        // configured sender id may resolve an exec approval inline.
        approvalCapability: {
          authorizeActorAction: ({ senderId }) => ({
            authorized: senderId === ${JSON.stringify(AUTHORIZED_SENDER_ID)},
          }),
        },
      },
    });
  },
};
`,
  );
}

/**
 * Builds the finalized message context a real channel plugin's inbound
 * capture produces, using the same production
 * `buildChannelInboundEventContext` any Discord/Telegram/etc. adapter calls
 * -- not a hand-typed stand-in for it.
 */
function buildFixtureInboundContext(senderId: string) {
  return buildChannelInboundEventContext({
    channel: FIXTURE_CHANNEL_ID,
    accountId: "default",
    messageId: `msg-${senderId}`,
    from: `${FIXTURE_CHANNEL_ID}:user:${senderId}`,
    sender: { id: senderId },
    conversation: { kind: "direct", id: senderId },
    route: {
      agentId: "main",
      routeSessionKey: `agent:main:${FIXTURE_CHANNEL_ID}:direct:${senderId}`,
    },
    reply: { to: `${FIXTURE_CHANNEL_ID}:user:${senderId}` },
    message: { rawBody: "run the command" },
  });
}

describe("exec-approval origin authorization against a real channel-inbound capture", () => {
  const cleanup: Cleanup[] = [];

  afterEach(async () => {
    for (const step of cleanup.splice(0).toReversed()) {
      await step();
    }
    clearRuntimeConfigSnapshot();
    clearConfigCache();
    clearSessionStoreCacheForTest();
  });

  it("captures the real per-message sender id through buildChannelInboundEventContext", () => {
    const ctx = buildFixtureInboundContext(AUTHORIZED_SENDER_ID);
    // This is the finding the ticket needed closed: SenderFacts.id lands on
    // `ctx.SenderId` unconditionally -- a channel author does not have to
    // separately hand-roll a `channelContext.sender.id` for the real
    // per-turn tool-building path (`sessionCtx.SenderId` at
    // `src/auto-reply/reply/agent-runner-utils.ts:307` and
    // `get-reply-run-execute.ts:349`) to see the sender.
    expect(ctx.SenderId).toBe(AUTHORIZED_SENDER_ID);
    expect(ctx.OriginatingChannel).toBe(FIXTURE_CHANNEL_ID);
  });

  it(
    "routes an unauthorized sender's turn to async approval-pending and an authorized sender's turn to an inline wait",
    async () => {
      const envSnapshot = captureEnv(TEST_ENV_KEYS);
      cleanup.push(() => envSnapshot.restore());

      const tempHome = await mkdtemp(
        path.join(tmpdir(), "openclaw-exec-approval-channel-sender-e2e-"),
      );
      cleanup.push(() => rm(tempHome, { recursive: true, force: true, maxRetries: 5 }));

      const stateDir = path.join(tempHome, ".openclaw");
      const workspaceDir = path.join(tempHome, "workspace");
      const bundledRoot = path.join(tempHome, "bundled");
      await mkdir(workspaceDir, { recursive: true });
      await mkdir(stateDir, { recursive: true });
      await writeBundledChannelPlugin(bundledRoot);

      const port = await getFreeGatewayPort();
      const token = "exec-approval-channel-sender-e2e-token";
      const configPath = path.join(stateDir, "openclaw.json");
      await writeFile(
        configPath,
        `${JSON.stringify(
          {
            gateway: {
              port,
              auth: { mode: "token", token },
            },
            plugins: {
              enabled: true,
              allow: [PLUGIN_ID],
              entries: { [PLUGIN_ID]: { enabled: true } },
            },
            tools: {
              exec: {
                host: "gateway",
                security: "allowlist",
                ask: "always",
              },
            },
          },
          null,
          2,
        )}\n`,
        "utf8",
      );

      setTestEnvValue("HOME", tempHome);
      setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
      setTestEnvValue("OPENCLAW_CONFIG_PATH", configPath);
      setTestEnvValue("OPENCLAW_GATEWAY_TOKEN", token);
      setTestEnvValue("OPENCLAW_GATEWAY_PORT", String(port));
      setTestEnvValue("OPENCLAW_BUNDLED_PLUGINS_DIR", bundledRoot);
      setTestEnvValue("OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR", "1");
      setTestEnvValue("OPENCLAW_SKIP_CHANNELS", "1");
      setTestEnvValue("OPENCLAW_SKIP_GMAIL_WATCHER", "1");
      setTestEnvValue("OPENCLAW_SKIP_CRON", "1");
      setTestEnvValue("OPENCLAW_SKIP_CANVAS_HOST", "1");
      setTestEnvValue("OPENCLAW_SKIP_BROWSER_CONTROL_SERVER", "1");
      setTestEnvValue("OPENCLAW_SKIP_PROVIDERS", "1");
      // Deliberately NOT setting OPENCLAW_TEST_MINIMAL_GATEWAY: that flag
      // stubs out the plugin registry entirely
      // (src/gateway/server-startup-plugins.ts:172), which would make the
      // fixture channel invisible to `getChannelPlugin()` and defeat the
      // whole point of this test.
      clearRuntimeConfigSnapshot();
      clearConfigCache();
      clearSessionStoreCacheForTest();

      const server = await startGatewayServer(port, {
        bind: "loopback",
        auth: { mode: "token", token },
        controlUiEnabled: false,
        sidecarStartup: "defer",
      });
      cleanup.push(() => server.close());

      const operator = await connectGatewayClient({
        url: `ws://127.0.0.1:${port}`,
        token,
        clientName: GATEWAY_CLIENT_NAMES.TEST,
        clientDisplayName: "approval operator",
        mode: GATEWAY_CLIENT_MODES.TEST,
        scopes: [ADMIN_SCOPE],
        caps: [GATEWAY_CLIENT_CAPS.EXEC_APPROVALS],
        requestTimeoutMs: GATEWAY_CONNECT_TIMEOUT_MS,
        timeoutMs: GATEWAY_CONNECT_TIMEOUT_MS,
      });
      cleanup.push(() => disconnectGatewayClient(operator));

      // Route A: unauthorized sender falls back to async approval-pending,
      // identical to a channel with no native approval UI.
      const unauthorizedCtx = buildFixtureInboundContext(UNAUTHORIZED_SENDER_ID);
      const unauthorizedTool = createExecTool({
        host: "gateway",
        security: "allowlist",
        ask: "always",
        cwd: workspaceDir,
        approvalRunningNoticeMs: 0,
        messageProvider: FIXTURE_CHANNEL_ID,
        senderId: unauthorizedCtx.SenderId,
      });
      const unauthorizedResult = await unauthorizedTool.execute("unauthorized-call", {
        command: "printf 'unauthorized\\n'",
        workdir: workspaceDir,
        timeout: 5,
      });
      expect(unauthorizedResult.details.status).toBe("approval-pending");
      if (unauthorizedResult.details.status !== "approval-pending") {
        throw new Error("expected approval-pending exec result for the unauthorized sender");
      }
      await operator.request(
        "exec.approval.resolve",
        { id: unauthorizedResult.details.approvalId, decision: "allow-once" },
        { timeoutMs: 10_000 },
      );

      // Route B: the authorized sender's turn waits inline and gets the real
      // exec output back from the same `execute()` call, exactly like a
      // native Telegram/Discord `/approve` resolution would.
      const authorizedCtx = buildFixtureInboundContext(AUTHORIZED_SENDER_ID);
      // `approvalFollowupMode` must stay unset here: `shouldAwaitGatewayApprovalInline`
      // (src/agents/bash-tools.exec-host-gateway.ts:436) bails out to the async
      // path unconditionally whenever it is defined, before it even looks at the
      // channel or sender. Setting it would silently defeat the inline-wait
      // assertion below regardless of authorization.
      const authorizedTool = createExecTool({
        host: "gateway",
        security: "allowlist",
        ask: "always",
        cwd: workspaceDir,
        approvalRunningNoticeMs: 0,
        messageProvider: FIXTURE_CHANNEL_ID,
        senderId: authorizedCtx.SenderId,
      });
      const authorizedExecPromise = authorizedTool.execute("authorized-call", {
        command: "printf 'inline\\n'",
        workdir: workspaceDir,
        timeout: 5,
      });

      const approvalId = await withTimeout(
        (async () => {
          for (;;) {
            const approvals = (await operator.request(
              "exec.approval.list",
              {},
              {
                timeoutMs: 10_000,
              },
            )) as Array<{ id?: string; request?: { command?: string } }>;
            const match = approvals.find((entry) => entry.request?.command?.includes("inline"));
            if (match?.id) {
              return match.id;
            }
            await new Promise((resolve) => {
              setTimeout(resolve, 100);
            });
          }
        })(),
        15_000,
        { message: "timed out waiting for the inline-wait approval to appear" },
      );
      await operator.request(
        "exec.approval.resolve",
        { id: approvalId, decision: "allow-once" },
        { timeoutMs: 10_000 },
      );

      const authorizedResult = await withTimeout(authorizedExecPromise, 15_000, {
        message: "timed out waiting for the inline-wait exec result",
      });
      // The inline-wait path never surfaces "approval-pending" to the
      // caller: `execute()` itself blocks until resolved and returns the
      // real command output.
      expect(authorizedResult.details.status).toBe("completed");
      if (authorizedResult.details.status !== "completed") {
        throw new Error("expected a completed exec result for the authorized sender");
      }
      expect(authorizedResult.details.aggregated).toBe("inline");
    },
    EXEC_APPROVAL_E2E_TIMEOUT_MS,
  );
});
