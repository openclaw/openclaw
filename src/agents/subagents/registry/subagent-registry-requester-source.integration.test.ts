import { describe, expect, it } from "vitest";
import { replaceSessionEntry } from "../../../config/sessions/session-accessor.js";
import { createOperatorRecoveryFixture } from "../../../gateway/operator-run-recovery.test-support.js";
import { createContext } from "../../../gateway/server-plugin-in-process-dispatch.test-support.js";
import {
  bindGatewayContextResolver,
  getPluginRuntimeGatewayRequestScope,
} from "../../../plugins/runtime/gateway-request-scope.js";
import { ensureProfileForEmail } from "../../../state/user-profiles.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import { createSubagentRunRecord } from "../../subagent-test-fixtures.test-helpers.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import {
  getUnrestorableSubagentCompletionSourceReason,
  restoreSubagentRequesterSource,
} from "./subagent-registry-requester-source.js";
import {
  loadSubagentRegistryFromSqlite,
  saveSubagentRegistryToSqlite,
} from "./subagent-registry-state.fixture.test-support.js";

describe("cold SQLite original requester custody", () => {
  it.each([false, true])(
    "restores the original route-less principal after resident custody is discarded (collector=%s)",
    async (collect) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const profile = ensureProfileForEmail("cold-original@example.test");
        const fixture = await createOperatorRecoveryFixture({
          stateDir: state.stateDir,
          context: createContext(),
          profileId: profile.id,
          config: {},
          sourceIngress: "internal",
        });
        const child = createSubagentRunRecord({
          runId: "cold-child",
          childAgentId: "main",
          childSessionKey: "agent:main:subagent:cold-child",
          requesterAgentId: "main",
          requesterSessionKey: fixture.target.sessionKey,
          requesterStorePath: fixture.target.storePath,
          requesterTurnRunId: fixture.target.sourceRunId,
          completionRequesterSessionId: fixture.entry.sessionId,
          completionRequesterLifecycleRevision: fixture.entry.lifecycleRevision,
          operatorRecoverySource: fixture.entry.restartRecoveryOperatorSource,
          completionAuthorityRequired: true,
          collect,
          requesterOrigin: undefined,
        });
        saveSubagentRegistryToSqlite(new Map([[child.runId, child]]));
        subagentRuns.clear();
        const restored = loadSubagentRegistryFromSqlite().get(child.runId)!;
        expect(restored).not.toBe(child);
        expect(restored.requesterOrigin).toBeUndefined();
        subagentRuns.set(restored.runId, restored);
        const resolver = () => fixture.context;
        bindGatewayContextResolver(restored, resolver);
        try {
          expect(() => subagentRuns.runWithCompletionAuthority(restored, () => true)).toThrow(
            "no longer active",
          );
          await restoreSubagentRequesterSource(restored, resolver, () => true);
          expect(
            subagentRuns.runWithCompletionAuthority(
              restored,
              () =>
                getPluginRuntimeGatewayRequestScope()?.client?.authenticatedUserProfile?.profileId,
            ),
          ).toBe(profile.id);
          expect(getUnrestorableSubagentCompletionSourceReason(restored)).toBeUndefined();
        } finally {
          subagentRuns.clear();
        }
      });
    },
  );
  it("does not replace the original principal after a persisted requester reset", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const profile = ensureProfileForEmail("cold-reset@example.test");
      const fixture = await createOperatorRecoveryFixture({
        stateDir: state.stateDir,
        context: createContext(),
        profileId: profile.id,
        config: {},
        sourceIngress: "internal",
      });
      const child = createSubagentRunRecord({
        runId: "cold-child-reset",
        childAgentId: "main",
        childSessionKey: "agent:main:subagent:cold-child-reset",
        requesterAgentId: "main",
        requesterSessionKey: fixture.target.sessionKey,
        requesterStorePath: fixture.target.storePath,
        requesterTurnRunId: fixture.target.sourceRunId,
        completionRequesterSessionId: fixture.entry.sessionId,
        completionRequesterLifecycleRevision: fixture.entry.lifecycleRevision,
        operatorRecoverySource: fixture.entry.restartRecoveryOperatorSource,
        completionAuthorityRequired: true,
      });
      saveSubagentRegistryToSqlite(new Map([[child.runId, child]]));
      subagentRuns.clear();
      const restored = loadSubagentRegistryFromSqlite().get(child.runId)!;
      subagentRuns.set(restored.runId, restored);
      const resolver = () => fixture.context;
      bindGatewayContextResolver(restored, resolver);
      await replaceSessionEntry(fixture.target, {
        sessionId: "successor",
        lifecycleRevision: "new-lifecycle",
        updatedAt: 2,
      });
      try {
        await restoreSubagentRequesterSource(restored, resolver, () => true);
        expect(getUnrestorableSubagentCompletionSourceReason(restored)).toBeDefined();
        expect(() => subagentRuns.runWithCompletionAuthority(restored, () => true)).toThrow(
          "no longer active",
        );
      } finally {
        subagentRuns.clear();
      }
    });
  });
});
