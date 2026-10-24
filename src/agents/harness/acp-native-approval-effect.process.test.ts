import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement } from "../../../test/helpers/promise.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createAgentRuntimeApprovalAuthorityValidator } from "../../gateway/agent-runtime-approval-authority.js";
import { diffGatewayReloadPaths } from "../../gateway/config-diff.js";
import {
  buildGatewayReloadPlan,
  isNoopGatewayReloadPlan,
  listConfigReloadRefinementPrefixes,
} from "../../gateway/config-reload-plan.js";
import { createTestApprovalManager } from "../../gateway/exec-approval-manager.test-support.js";
import {
  createCoreGatewayMethodDescriptors,
  createGatewayMethodRegistry,
} from "../../gateway/methods/registry.js";
import { createDirectChatContext } from "../../gateway/server-chat.agent-events.test-helpers.js";
import { cancelAgentRuntimeBoundApprovals } from "../../gateway/server-methods/approval-run-cancellation.js";
import { createPluginApprovalHandlers } from "../../gateway/server-methods/plugin-approval.js";
import { dispatchGatewayMethodInProcessRaw } from "../../gateway/server-plugin-in-process-dispatch.js";
import {
  registerAgentRunDelegatedAuthorityClosedHandler,
  validateAgentRunDelegatedAuthority,
} from "../../infra/agent-run-registry.js";
import type { PluginApprovalRequestPayload } from "../../infra/plugin-approvals.js";
import { readVisibleSessionTranscriptMessageEntries } from "../../plugin-sdk/session-transcript-runtime.js";
import { bindGatewayContextResolver } from "../../plugins/runtime/gateway-request-scope.js";
import { AsyncWorkScope } from "../../shared/async-work-scope.js";
import { createDeferredCore as createDeferred } from "../../shared/deferred.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  attemptFor,
  registerNative,
  useNativeProcessFixture,
} from "./acp-native-process.test-support.js";
import { runAgentHarnessAttempt } from "./selection.js";

const fixture = useNativeProcessFixture();

it.for(["allow", "deny", "cancel", "always-only"] as const)(
  "fences delegated native writes while the Gateway approval waits: %s",
  { timeout: 60000 },
  async (kind, test) => {
    const body = withOpenClawTestState({ label: "acp-native-approval-effect" }, async (state) => {
      const readPeer = async (name: string): Promise<unknown> =>
        JSON.parse(await fs.readFile(state.path("peer", `permission-${name}.json`), "utf8"));
      const readEffect = () =>
        fs.readFile(path.join(state.workspaceDir, "native-effect.txt"), "utf8");
      const config: OpenClawConfig = {
        session: { store: path.join(state.sessionsDir(), "sessions.json") },
      };
      const disabledConfig: OpenClawConfig = {
        ...config,
        plugins: { entries: { acpx: { config: { nativeAgents: { qwen: false } } } } },
      };
      const manager = createTestApprovalManager<PluginApprovalRequestPayload>(test, {
        approvalKind: "plugin",
        validateAgentRuntimeDelegatedAuthority: validateAgentRunDelegatedAuthority,
      });
      const gatewayWork = new AsyncWorkScope();
      const handlers = createPluginApprovalHandlers(manager);
      const methods = createGatewayMethodRegistry(createCoreGatewayMethodDescriptors(handlers));
      const context = createDirectChatContext({
        getRuntimeConfig: () => config,
        getGatewayMethodRegistry: () => methods,
        trackExecution: (run) => gatewayWork.track(run),
        pluginApprovalManager: manager,
        hasExecApprovalClients: () => true,
        validateAgentRuntimeApprovalAuthority: createAgentRuntimeApprovalAuthorityValidator(),
      });
      const stopWatchingAuthority = registerAgentRunDelegatedAuthorityClosedHandler(
        (authority, reason) => {
          void gatewayWork.track(() =>
            cancelAgentRuntimeBoundApprovals({ authority, reason, manager, publish: () => {} }),
          );
        },
      );
      let native: Awaited<ReturnType<typeof registerNative>> | undefined;
      try {
        native = await registerNative(state, config, "approval-effect-agent.mjs", {
          allowAlwaysOnly: kind === "always-only",
        });
        const attempt = await attemptFor(state, config, "qwen", "full");
        bindGatewayContextResolver(attempt.input.admittedRunContext, () => context);
        const entered = createDeferred<string>();
        const awaitDecision = manager.awaitDecision.bind(manager);
        vi.spyOn(manager, "awaitDecision").mockImplementation((id) => {
          const decision = awaitDecision(id);
          entered.resolve(id);
          return decision;
        });
        const abort = new AbortController();
        attempt.input.abortSignal = AbortSignal.any([test.signal, abort.signal]);
        const run = fixture.track(runAgentHarnessAttempt(attempt.input));
        try {
          const approvalId = await awaitGateBeforeSettlement(
            entered.promise,
            run,
            "Attempt ended before approval wait",
          );
          expect(await manager.listPendingRecords()).toHaveLength(1);
          expect(await manager.getSnapshot(approvalId)).toMatchObject({
            request: {
              pluginId: "acpx",
              runId: attempt.input.runId,
              sessionKey: attempt.input.sessionKey,
              toolCallId: "native-write",
              allowedDecisions: kind === "always-only" ? ["deny"] : ["allow-once", "deny"],
            },
          });
          expect(await readPeer("request")).toMatchObject({
            toolCallId: "native-write",
            kind: "edit",
          });
          await expect(readEffect()).rejects.toMatchObject({ code: "ENOENT" });
          if (kind === "allow") {
            const plan = buildGatewayReloadPlan(
              diffGatewayReloadPaths(config, disabledConfig, listConfigReloadRefinementPrefixes()),
            );
            expect(isNoopGatewayReloadPlan(plan)).toBe(true);
            native.getRuntimeConfig.mockReturnValue(disabledConfig);
          }
          if (kind === "always-only") {
            await expect(
              dispatchGatewayMethodInProcessRaw(
                "plugin.approval.resolve",
                { id: approvalId, decision: "allow-once" },
                {
                  forceSyntheticClient: true,
                  operatorRoleActor: { kind: "system" },
                  syntheticScopes: ["operator.approvals"],
                  resolveGatewayContext: () => context,
                },
              ),
            ).resolves.toMatchObject({
              ok: false,
              error: { code: "INVALID_REQUEST", details: { allowedDecisions: ["deny"] } },
            });
          }
          if (kind === "cancel") {
            abort.abort();
          }
          // A late allow cannot revive the cancelled native permission request.
          const resolution = await manager.resolveDetailed(
            approvalId,
            kind === "deny" || kind === "always-only" ? "deny" : "allow-once",
            { kind: "device", id: "test-reviewer" },
          );
          expect(resolution.outcome).toBe(kind === "cancel" ? "already-resolved" : "resolved");
          const result = await run;
          expect(result.terminal).toMatchObject({ kind: kind === "cancel" ? "aborted" : "ok" });
          expect(await manager.listPendingRecords()).toEqual([]);
          if (kind === "allow") {
            const transcript = await readVisibleSessionTranscriptMessageEntries(attempt.target);
            expect(transcript.map((row) => row.role)).toEqual(["user", "assistant"]);
            attempt.close();
            const next = await attemptFor(state, disabledConfig, "qwen", "full");
            try {
              await expect(runAgentHarnessAttempt(next.input)).rejects.toThrow("disabled");
              expect(await readVisibleSessionTranscriptMessageEntries(attempt.target)).toEqual(
                transcript,
              );
            } finally {
              next.close();
            }
          }
          if (kind === "cancel") {
            expect(await manager.getSnapshot(approvalId)).toMatchObject({
              status: "cancelled",
              terminalReason: "run-aborted",
            });
          }
        } finally {
          abort.abort();
          attempt.close();
          await Promise.allSettled([run]);
        }
      } finally {
        stopWatchingAuthority();
        await native?.service.stop?.(native.context);
        await manager.drain();
        await gatewayWork.drain();
      }
      // Inspect after shutdown so a late native permission reply cannot race this assertion.
      if (kind !== "allow") {
        await expect(readEffect()).rejects.toMatchObject({ code: "ENOENT" });
      } else {
        expect(await readEffect()).toBe("approved native effect");
      }
      if (kind !== "cancel") {
        expect(await readPeer("result")).toMatchObject({
          outcome: { outcome: "selected", optionId: kind === "allow" ? "allow" : "deny" },
        });
      }
    });
    await fixture.track(body);
  },
);
