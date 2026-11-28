// A scheduled run hands a turn to a busy Claude CLI session. The continuation is
// captured while the occurrence is live, but queued CLI admission starts after it
// ended and rechecks the sender's policy independently of the retired request scope.
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  resolveMcpLoopbackPolicyTools,
  resolveMcpLoopbackScopedTools,
} from "../../gateway/mcp-http.runtime.js";
import { OperatorRefusalError } from "../../gateway/operator-refusal.js";
import {
  pairedOperator,
  persistDevices,
  recoveryFixture,
} from "../../gateway/operator-run-recovery.test-support.js";
import { captureOperatorToolGatewayContinuationContext } from "../../gateway/server-plugin-in-process-dispatch.js";
import { createSyntheticPluginRuntimeClient } from "../../gateway/server-plugin-runtime-client.js";
import {
  resolveEventSessionKeyForPolicy,
  resolveEventSessionRoutingPolicy,
} from "../../infra/event-session-routing.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  getPluginRuntimeGatewayRequestScope,
  withPluginRuntimeGatewayRequestScope,
} from "../../plugins/runtime/gateway-request-scope.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { prepareSystemAgentRunAdmission } from "../admitted-run-context.js";
import {
  createClaudeMcpCliBackend,
  testing as cliBackendsTesting,
} from "../cli-backends.test-support.js";
import {
  createCliRunnerPrepareFixture,
  createTestMcpLoopbackClientGrant,
} from "../cli-runner.test-helpers.js";
import {
  createJsonlStdinBackendConfig,
  mockCliMcpPreparation,
  setRawCliBackendForPrepareTest,
} from "./prepare-mcp.test-support.js";
import { prepareCliRunContext } from "./prepare.js";
import {
  resetCliRunnerPrepareTestDeps,
  setCliRunnerPrepareTestDeps,
} from "./prepare.test-support.js";

describe("CLI preparation for a turn handed off by a scheduled run", () => {
  beforeEach(() => {
    cliBackendsTesting.setDepsForTest({
      resolvePluginSetupCliBackend: () => undefined,
      resolveRuntimeCliBackends: () => [createClaudeMcpCliBackend()],
    });
    setCliRunnerPrepareTestDeps({
      isWorkspaceBootstrapPending: async () => false,
      makeBootstrapWarn: () => () => undefined,
      resolveBootstrapContextForRun: async () => ({ bootstrapFiles: [], contextFiles: [] }),
      getActiveMcpLoopbackRuntime: () => ({
        port: 31783,
        ownerToken: "loopback-owner-token",
      }),
      mintMcpLoopbackClientGrant: createTestMcpLoopbackClientGrant,
      bindMcpLoopbackClientGrantAdmission: () => true,
      revokeMcpLoopbackClientGrant: () => true,
      revokeMintedMcpLoopbackClientGrant: () => true,
      resolveMcpLoopbackPolicyTools,
      resolveMcpLoopbackScopedTools,
      resolveOpenClawReferencePaths: async () => ({ docsPath: null, sourcePath: null }),
      prepareClaudeCliSkillsPlugin: async () => ({ args: [], cleanup: async () => {} }),
      getCliLiveSessionGeneration: () => undefined,
      loadManifestModelCatalog: () => [],
    });
  });

  afterEach(() => {
    clearRuntimeConfigSnapshot();
    resetCliRunnerPrepareTestDeps();
    cliBackendsTesting.resetDepsForTest();
  });

  it.each(["none", "sender device removed", "sender role denied", "explicit stop"] as const)(
    "prepares the queued CLI turn after the occurrence ended (%s)",
    (revocation) =>
      withOpenClawTestState({ scenario: "minimal" }, async ({ stateDir }) => {
        const profile = ensureProfileForEmail("scheduled-sender@example.test");
        const occurrence = await recoveryFixture(stateDir, profile.id, {
          device: pairedOperator(),
          scopes: ["operator.write"],
        });
        const sender = expectDefined(await occurrence.restore(), "scheduled sender authority");
        const fixture = createCliRunnerPrepareFixture(
          (params) => {
            setRuntimeConfigSnapshot(params.config ?? {});
            return prepareCliRunContext({ skillsSnapshot: { prompt: "", skills: [] }, ...params });
          },
          { make: () => stateDir },
        );
        // sessions_send captures the receiver's continuation before its queued run starts.
        const senderClient = createSyntheticPluginRuntimeClient({
          authenticatedUserProfile: occurrence.client.authenticatedUserProfile,
          operatorRoleActor: { kind: "operator", profileId: sender.authority.profileId },
          operatorRunAuthority: sender.authority,
          agentToolCaller: { agentId: "main", sessionKey: "agent:main:cron-sender" },
          scopes: ["operator.write"],
        });
        const accepted = expectDefined(
          await withPluginRuntimeGatewayRequestScope(
            {
              client: senderClient,
              context: occurrence.context,
              resolveGatewayContext: occurrence.context.resolveGatewayContext,
              isWebchatConnect: () => false,
            },
            () => captureOperatorToolGatewayContinuationContext(),
          ),
          "receiver continuation",
        );
        try {
          occurrence.retire();
          if (revocation === "sender device removed") {
            persistDevices(stateDir, [], "both");
          } else if (revocation === "sender role denied") {
            occurrence.setConfig({
              gateway: {
                roles: {
                  default: "blocked",
                  definitions: {
                    blocked: { agents: "*", sessions: { others: "none" }, scopes: [] },
                  },
                },
              },
            });
          }
          const prepare = accepted.runWithRequester(async () => {
            const admission = prepareSystemAgentRunAdmission(
              {},
              "queued-cli-turn",
              "main",
              "test",
              undefined,
              getPluginRuntimeGatewayRequestScope()?.client?.internal?.operatorRunAuthority,
            );
            try {
              const context = await fixture.prepare({
                runId: "queued-cli-turn",
                provider: "claude-cli",
                model: "opus",
                preparedRunAdmission: admission,
                ...(revocation === "explicit stop"
                  ? { abortSignal: AbortSignal.abort(new Error("agent run aborted")) }
                  : {}),
                config: {},
              });
              try {
                expect(context.params.admittedRunContext).toBeDefined();
              } finally {
                await context.preparedBackend.cleanup?.();
              }
            } finally {
              admission.close();
            }
          });
          if (revocation === "explicit stop") {
            await expect(prepare).rejects.toThrow("agent run aborted");
          } else if (revocation !== "none") {
            await expect(prepare).rejects.toBeInstanceOf(OperatorRefusalError);
          } else {
            await prepare;
          }
        } finally {
          accepted.release();
          sender.release();
          await fixture.settle();
        }
      }),
  );
});

describe("CLI preparation for a scheduled account", () => {
  let fixture: ReturnType<typeof createCliRunnerPrepareFixture>;

  beforeEach(() => {
    mockCliMcpPreparation({ getActiveMcpLoopbackRuntime: () => undefined });
    fixture = createCliRunnerPrepareFixture((params) => {
      setRuntimeConfigSnapshot(params.config ?? {});
      return prepareCliRunContext({ skillsSnapshot: { prompt: "", skills: [] }, ...params });
    });
  });

  afterEach(async () => {
    await fixture.cleanup();
    clearRuntimeConfigSnapshot();
    setActivePluginRegistry(createTestRegistry());
    resetCliRunnerPrepareTestDeps();
    cliBackendsTesting.resetDepsForTest();
  });

  it.each([
    { name: "the delivery channel", configured: true, messageProvider: undefined, refused: false },
    {
      name: "cross-channel delivery",
      configured: false,
      messageProvider: undefined,
      messageChannel: "discord",
      sessionKey: "agent:main:telegram:direct:123",
      refused: false,
    },
    { name: "a removed account", configured: false, messageProvider: undefined, refused: true },
    { name: "an explicit provider", configured: true, messageProvider: "slack", refused: true },
  ])(
    "resolves scheduled CLI accounts with $name",
    async ({
      configured,
      messageProvider,
      refused,
      messageChannel = "telegram",
      sessionKey = "agent:main:cron:scheduled-account",
    }) => {
      const config: OpenClawConfig = {
        session: { dmScope: "main" },
        channels: {
          discord: { accounts: { scheduled: {} } },
          telegram: {
            allowFrom: ["123"],
            accounts: { default: {}, ...(configured ? { scheduled: {} } : {}) },
          },
        },
      };
      setActivePluginRegistry(
        createTestRegistry(
          (["telegram", "discord"] as const).map((id) => ({
            pluginId: id,
            plugin: createChannelTestPluginBase({
              id,
              config: {
                listAccountIds: (cfg) => Object.keys(cfg.channels?.[id]?.accounts ?? {}),
              },
            }),
            source: "test",
          })),
          { config },
        ),
      );
      setRawCliBackendForPrepareTest({
        id: "selectable-cli",
        pluginId: "selectable-plugin",
        bundleMcp: false,
        nativeToolMode: "selectable",
        toolAvailabilityEnforcement: "execution-args",
        resolveExecutionArgs: ({ baseArgs }) => [...baseArgs],
        config: createJsonlStdinBackendConfig("selectable-cli"),
      });
      const projectTools = vi.fn((_scope: Parameters<typeof resolveMcpLoopbackPolicyTools>[0]) => ({
        agentId: "main",
        tools: [{ name: "read" }],
      }));
      setCliRunnerPrepareTestDeps({ resolveMcpLoopbackPolicyTools: projectTools });
      const scheduledToolPolicy = {
        version: 1,
        mode: "account",
        ownerSessionKey: "agent:main:maintenance",
        ownerAccountId: "scheduled",
        ownerOrigin: { kind: "local" },
      } as const;
      const run = fixture.prepare({
        config,
        provider: "selectable-cli",
        sessionKey,
        messageChannel,
        messageProvider,
        toolsAllow: ["read"],
        scheduledToolPolicy,
      });
      if (refused) {
        await expect(run).rejects.toThrow('Scheduled account "scheduled" is unavailable.');
        return;
      }
      const context = await run;
      expect(context.params.cliToolAvailability).toEqual({ native: [], openClaw: ["read"] });
      expect(projectTools).toHaveBeenCalledWith(
        expect.objectContaining({ context: expect.objectContaining({ toolsAllow: ["read"] }) }),
      );
      expect(context.params.scheduledToolPolicy).toEqual(scheduledToolPolicy);
      expect(context.params.senderId).toBeUndefined();
      if (messageChannel === "discord") {
        expect(
          resolveEventSessionKeyForPolicy(
            sessionKey,
            resolveEventSessionRoutingPolicy({
              cfg: context.params.config,
              sessionKey,
              channel: context.params.messageProvider,
              accountId: context.params.agentAccountId,
            }),
          ),
        ).toBe("agent:main:main");
      }
      await context.preparedBackend.cleanup?.();
    },
  );
});
