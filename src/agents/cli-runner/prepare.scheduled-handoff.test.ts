// A scheduled run hands a turn to a busy Claude CLI session. The turn is admitted while the
// occurrence is live and starts after it ended, so CLI preparation runs under the sender's
// retired request scope. The admitted run owns the authority, not that scope.
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import { invalidateGatewayDeviceRevocation } from "../../gateway/device-revocation.js";
import {
  resolveMcpLoopbackPolicyTools,
  resolveMcpLoopbackScopedTools,
} from "../../gateway/mcp-http.runtime.js";
import { captureGatewayOperatorContinuation } from "../../gateway/operator-run-recovery.js";
import {
  pairedOperator,
  recoveryFixture,
} from "../../gateway/operator-run-recovery.test-support.js";
import { createSyntheticPluginRuntimeClient } from "../../gateway/server-plugin-runtime-client.js";
import { withPluginRuntimeGatewayRequestScope } from "../../plugins/runtime/gateway-request-scope.js";
import { setUserProfileRole } from "../../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
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
        nonOwnerToken: "loopback-non-owner-token",
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

  it.each<{ revocation: string; rejection?: RegExp }>([
    { revocation: "none" },
    { revocation: "sender device removed", rejection: /operator authority changed/i },
    { revocation: "sender role changed", rejection: /operator authority changed/i },
    { revocation: "explicit stop", rejection: /agent run aborted/i },
  ])(
    "prepares the queued CLI turn after the occurrence ended ($revocation)",
    ({ revocation, rejection }) =>
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
        // sessions_send admits the receiver with the sending run's in-process client.
        const senderClient = createSyntheticPluginRuntimeClient({
          authenticatedUserProfile: occurrence.client.authenticatedUserProfile,
          operatorRoleActor: { kind: "operator", profileId: sender.authority.profileId },
          operatorRunAuthority: sender.authority,
          agentToolCaller: { agentId: "main", sessionKey: "agent:main:cron-sender" },
          scopes: ["operator.write"],
        });
        const accepted = expectDefined(
          await captureGatewayOperatorContinuation({
            client: senderClient,
            context: occurrence.context,
          }),
          "receiver continuation",
        );
        const admission = prepareSystemAgentRunAdmission(
          {},
          "queued-cli-turn",
          "main",
          "test",
          undefined,
          accepted.authority,
        );
        try {
          occurrence.retire();
          expect(sender.authority.assertCurrent).toThrow();
          if (revocation === "sender device removed") {
            invalidateGatewayDeviceRevocation(occurrence.context, "recovery-device", "operator");
          } else if (revocation === "sender role changed") {
            setUserProfileRole(profile.id, "new-role");
          }
          const prepare = withPluginRuntimeGatewayRequestScope(
            {
              context: occurrence.context,
              client: senderClient,
              isWebchatConnect: () => false,
            },
            () =>
              fixture.prepare({
                runId: "queued-cli-turn",
                provider: "claude-cli",
                model: "opus",
                preparedRunAdmission: admission,
                ...(revocation === "explicit stop"
                  ? { abortSignal: AbortSignal.abort(new Error("agent run aborted")) }
                  : {}),
                config: {},
              }),
          );
          if (rejection) {
            // The retained continuation and the run's own Stop still end the turn.
            await expect(prepare).rejects.toThrow(rejection);
            return;
          }
          const context = await prepare;
          try {
            expect(context.params.admittedRunContext).toBeDefined();
          } finally {
            await context.preparedBackend.cleanup?.();
          }
        } finally {
          admission.close();
          accepted.release();
          sender.release();
          await fixture.settle();
        }
      }),
  );
});
