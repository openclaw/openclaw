// Real persistence -> reload -> render proof for the give-up terminal `failed`
// delivery leak (#154834). A drained give-up row (delivery.status="failed" AND
// cleanupCompletedAt stamped by completeCleanupBookkeeping) must NOT re-render
// as "awaiting delivery" after a registry restart, while a `failed` row that is
// still retrying (no cleanupCompletedAt) MUST stay visible. Both rows are written
// through the production SQLite persistence layer, reloaded by a fresh registry on
// the same store, and rendered by the real async buildActiveSubagentRuntimeContext.
import { describe, expect, it } from "vitest";
import "./subagent-registry.mocks.shared.js";
// Preserve module setup before modules that consume it.
// oxfmt-ignore
import {
  announceSpy,
  createSubagentPersistenceRuntime,
  resetSubagentPersistenceGatewayCalls,
  useSubagentPersistenceFixture,
} from "./subagent-registry.persistence-fixture.test-support.js";
import { resolvePhysicalSessionStorePath } from "../../../config/sessions/session-store-path.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { callGateway } from "../../../gateway/call.js";
import { createSubagentRunRecord } from "../../subagent-test-fixtures.test-helpers.js";
import { buildActiveSubagentRuntimeContext } from "./subagent-active-context.js";
import { saveSubagentRegistryToSqlite } from "./subagent-registry-state.fixture.test-support.js";
import { writeChildSession } from "./subagent-registry.persistence.test-support.js";
import { loadSubagentRegistryFromSqlite } from "./subagent-registry.store.sqlite.js";
import {
  activateSubagentRegistry,
  initSubagentRegistry,
  resetSubagentRegistryForTests,
} from "./subagent-registry.test-helpers.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

const CONTROLLER_SESSION_KEY = "agent:main:main";

describe("give-up terminal failed delivery context: persisted reload proof", () => {
  const fixture = useSubagentPersistenceFixture();

  const restartRegistry = async () => {
    await resetSubagentRegistryForTests({ persist: false });
    await initSubagentRegistry();
    const recoveryRuntime = createSubagentPersistenceRuntime(callGateway);
    const gateway = { recoveryRuntime, resolveGatewayContext: () => gateway as never };
    await activateSubagentRegistry(() => gateway as never);
  };

  it("drops a persisted drained failed row after reload but keeps a retrying failed row", async () => {
    await fixture.allocateStateDir();
    resetSubagentPersistenceGatewayCalls(callGateway);
    announceSpy.mockResolvedValue("delivered");

    const now = Date.now();
    const storePath = resolvePhysicalSessionStorePath(
      { sessionKey: CONTROLLER_SESSION_KEY, agentId: "main" },
      {} as OpenClawConfig,
    );
    // A: give-up terminal — delivery failed AND cleanup bookkeeping completed.
    // This is the durable shape finalizeResumedAnnounceGiveUp + completeCleanupBookkeeping
    // leave behind; resumeSubagentRun hard-stops it.
    const drained = createSubagentRunRecord({
      runId: "run-giveup-drained",
      childSessionKey: "agent:main:subagent:giveup-drained",
      controllerSessionKey: CONTROLLER_SESSION_KEY,
      requesterSessionKey: CONTROLLER_SESSION_KEY,
      requesterDisplayKey: "main",
      requesterStorePath: storePath,
      controllerStorePath: storePath,
      task: "deliver the abandoned report",
      cleanup: "keep",
      expectsCompletionMessage: true,
      createdAt: now - 5_000,
      execution: {
        status: "terminal",
        startedAt: now - 4_000,
        endedAt: now - 1_000,
        outcome: { status: "error", error: "gateway request timeout" },
      },
      completion: { required: true, resultText: "drained give-up result" },
      delivery: { status: "failed", lastError: "retries exhausted" },
      cleanupCompletedAt: now,
    });

    // B: failed but still retrying — no cleanupCompletedAt yet, so it stays outstanding.
    const retrying = createSubagentRunRecord({
      runId: "run-still-retrying",
      childSessionKey: "agent:main:subagent:still-retrying",
      controllerSessionKey: CONTROLLER_SESSION_KEY,
      requesterSessionKey: CONTROLLER_SESSION_KEY,
      requesterDisplayKey: "main",
      requesterStorePath: storePath,
      controllerStorePath: storePath,
      task: "deliver the retryable report",
      cleanup: "keep",
      expectsCompletionMessage: true,
      createdAt: now - 4_000,
      execution: {
        status: "terminal",
        startedAt: now - 3_000,
        endedAt: now - 500,
        outcome: { status: "error", error: "transient send error" },
      },
      completion: { required: true, resultText: "retrying failed result" },
      delivery: { status: "failed", lastError: "transient send error" },
    });

    // Production persistence: write the registry rows + child session entries to SQLite.
    saveSubagentRegistryToSqlite(
      new Map<string, SubagentRunRecord>([
        [drained.runId, drained],
        [retrying.runId, retrying],
      ]),
    );
    await writeChildSession(fixture.stateDir, drained.childSessionKey, "sess-drained");
    await writeChildSession(fixture.stateDir, retrying.childSessionKey, "sess-retrying");

    // Prove durability: both rows are in the on-disk store before reload.
    expect(loadSubagentRegistryFromSqlite().get(drained.runId)?.delivery?.status).toBe("failed");
    expect(loadSubagentRegistryFromSqlite().get(retrying.runId)?.delivery?.status).toBe("failed");

    // Dispose the in-memory registry and reload from the same store.
    await restartRegistry();

    // Render the real requester runtime context from the reloaded registry.
    const prompt = await buildActiveSubagentRuntimeContext({
      cfg: {} as OpenClawConfig,
      controllerSessionKey: CONTROLLER_SESSION_KEY,
    });

    // The drained give-up row must not reappear as awaiting delivery; the still-retrying
    // failed row must. This is the post-restart re-render the old predicate leaked.
    expect(prompt).toContain("## Child results awaiting delivery");
    expect(prompt).toContain("retrying failed result");
    // The drained row may still surface as bounded recovery evidence under
    // "Recently Completed Subagents", but it must NOT be in the awaiting-delivery block.
    const deliveryBlock = (prompt ?? "").slice(
      (prompt ?? "").indexOf("## Child results awaiting delivery"),
    );
    expect(deliveryBlock).toContain("run-still-retrying");
    expect(deliveryBlock).not.toContain("run-giveup-drained");
    expect(deliveryBlock).not.toContain("drained give-up result");
  });
});
