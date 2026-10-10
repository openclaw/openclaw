import { describe, expect, it, vi } from "vitest";
import {
  createWorkboardLifecycleService,
  syncWorkboardAgentEnded,
  syncWorkboardSubagentEnded,
} from "./lifecycle-sync.js";
import { createLinkedCard, execution } from "./lifecycle-sync.test-support.js";
import { createWorkboardSqliteTestStore } from "./test/sqlite-store.js";

/**
 * Attempt-level agent_end hooks report one model candidate, never the overall
 * run. These regressions pin the deferral contract added for issue #167574:
 * terminal writes wait for authoritative session state, ownership matching
 * stays exact, deferred completions nudge automation only after settlement,
 * and unmatched hooks skip session discovery.
 */
describe("Workboard attempt-level agent_end deferral", () => {
  it("keeps a live fallback run out of blocked on an attempt-level agent_end failure", async () => {
    const store = createWorkboardSqliteTestStore();
    const sessionKey = "agent:worker:subagent:workboard-ops-fallback-live";
    const card = await createLinkedCard(store, {
      sessionKey,
      runId: "run-agent",
      execution: execution(sessionKey, "run-agent"),
    });
    const readSessions = vi.fn().mockResolvedValue({
      sessions: [
        { key: sessionKey, status: "running", hasActiveRun: true, updatedAt: card.updatedAt + 1 },
      ],
      complete: true,
    });

    await syncWorkboardAgentEnded({
      store,
      event: { runId: "run-agent", success: false },
      context: { runId: "run-agent", sessionKey },
      now: card.updatedAt + 2,
      readSessions,
    });

    expect(readSessions).toHaveBeenCalledOnce();
    const vetoed = await store.get(card.id);
    expect(vetoed).toMatchObject({
      status: "running",
      execution: { status: "running" },
    });
    expect(vetoed?.metadata?.failureCount).toBeUndefined();
    expect(
      vetoed?.events?.some((event) => event.kind === "moved" && event.toStatus === "blocked"),
    ).toBe(false);
  });

  it("still blocks immediately when agent_end fails after the run ended", async () => {
    const store = createWorkboardSqliteTestStore();
    const sessionKey = "agent:worker:subagent:workboard-ops-terminal-failed";
    const card = await createLinkedCard(store, {
      sessionKey,
      runId: "run-agent",
      execution: execution(sessionKey, "run-agent"),
    });
    const readSessions = vi.fn().mockResolvedValue({
      sessions: [
        { key: sessionKey, status: "failed", hasActiveRun: false, updatedAt: card.updatedAt + 1 },
      ],
      complete: true,
    });

    await syncWorkboardAgentEnded({
      store,
      event: { runId: "run-agent", success: false },
      context: { runId: "run-agent", sessionKey },
      now: card.updatedAt + 2,
      readSessions,
    });

    await expect(store.get(card.id)).resolves.toMatchObject({
      status: "blocked",
      execution: { status: "blocked" },
      metadata: { failureCount: 1 },
    });
  });

  it("keeps the event terminal outcome when the lifecycle liveness read fails", async () => {
    const store = createWorkboardSqliteTestStore();
    const sessionKey = "agent:worker:subagent:workboard-ops-read-failure";
    const card = await createLinkedCard(store, {
      sessionKey,
      runId: "run-agent",
      execution: execution(sessionKey, "run-agent"),
    });
    const readSessions = vi.fn().mockRejectedValue(new Error("gateway unavailable"));

    await syncWorkboardAgentEnded({
      store,
      event: { runId: "run-agent", success: false },
      context: { runId: "run-agent", sessionKey },
      now: card.updatedAt + 2,
      readSessions,
    });

    expect(readSessions).toHaveBeenCalledOnce();
    await expect(store.get(card.id)).resolves.toMatchObject({
      status: "blocked",
      execution: { status: "blocked" },
    });
  });

  it("blocks on the event's exact terminal session while another agent runs the same suffix", async () => {
    const store = createWorkboardSqliteTestStore();
    const card = await createLinkedCard(store, {
      sessionKey: "subagent:workboard-ops-card",
      runId: "run-agent",
      execution: execution("subagent:workboard-ops-card", "run-agent"),
    });
    const alphaKey = "agent:alpha:subagent:workboard-ops-card";
    const betaKey = "agent:beta:subagent:workboard-ops-card";
    const readSessions = vi.fn().mockResolvedValue({
      sessions: [
        { key: alphaKey, status: "failed", hasActiveRun: false, updatedAt: card.updatedAt + 1 },
        { key: betaKey, status: "running", hasActiveRun: true, updatedAt: card.updatedAt + 1 },
      ],
      complete: true,
    });

    await syncWorkboardAgentEnded({
      store,
      event: { runId: "run-agent", success: false },
      context: { runId: "run-agent", sessionKey: alphaKey },
      now: card.updatedAt + 2,
      readSessions,
    });

    await expect(store.get(card.id)).resolves.toMatchObject({
      status: "blocked",
      execution: { status: "blocked" },
      metadata: { failureCount: 1 },
    });
  });

  it("vetoes an agentless card link on a unique live suffix match in a complete snapshot", async () => {
    const store = createWorkboardSqliteTestStore();
    const card = await createLinkedCard(store, {
      sessionKey: "subagent:workboard-ops-agentless",
      runId: "run-agent",
      execution: execution("subagent:workboard-ops-agentless", "run-agent"),
    });
    const liveKey = "agent:beta:subagent:workboard-ops-agentless";
    const readSessions = vi.fn().mockResolvedValue({
      sessions: [{ key: liveKey, status: "running", hasActiveRun: true }],
      complete: true,
    });

    await syncWorkboardAgentEnded({
      store,
      event: { runId: "run-agent", success: false },
      context: { runId: "run-agent" },
      now: card.updatedAt + 2,
      readSessions,
    });

    await expect(store.get(card.id)).resolves.toMatchObject({
      status: "running",
      execution: { status: "running" },
    });
    expect((await store.get(card.id))?.metadata?.failureCount).toBeUndefined();
  });

  it("does not veto an agentless card link when the suffix matches several sessions", async () => {
    const store = createWorkboardSqliteTestStore();
    const card = await createLinkedCard(store, {
      sessionKey: "subagent:workboard-ops-ambiguous",
      runId: "run-agent",
      execution: execution("subagent:workboard-ops-ambiguous", "run-agent"),
    });
    const readSessions = vi.fn().mockResolvedValue({
      sessions: [
        {
          key: "agent:alpha:subagent:workboard-ops-ambiguous",
          status: "failed",
          hasActiveRun: false,
        },
        {
          key: "agent:beta:subagent:workboard-ops-ambiguous",
          status: "running",
          hasActiveRun: true,
        },
      ],
      complete: true,
    });

    await syncWorkboardAgentEnded({
      store,
      event: { runId: "run-agent", success: false },
      context: { runId: "run-agent" },
      now: card.updatedAt + 2,
      readSessions,
    });

    await expect(store.get(card.id)).resolves.toMatchObject({
      status: "blocked",
      execution: { status: "blocked" },
    });
  });

  it("keeps exhausted-fallback failure terminal through ordered attempt hooks", async () => {
    const store = createWorkboardSqliteTestStore();
    const sessionKey = "agent:worker:subagent:workboard-ops-exhausted";
    const card = await createLinkedCard(store, {
      sessionKey,
      runId: "run-agent",
      execution: execution(sessionKey, "run-agent"),
    });
    const readSessions = vi.fn().mockResolvedValue({
      sessions: [
        { key: sessionKey, status: "running", hasActiveRun: true, updatedAt: card.updatedAt + 1 },
      ],
      complete: true,
    });

    // The primary candidate fails while the fallback keeps the run alive.
    await syncWorkboardAgentEnded({
      store,
      event: { runId: "run-agent", success: false },
      context: { runId: "run-agent", sessionKey },
      now: card.updatedAt + 2,
      readSessions,
    });
    await expect(store.get(card.id)).resolves.toMatchObject({ status: "running" });

    // The failing fallback can still emit a candidate-level success hook before
    // the runner settles the overall error; it must not review the card.
    await syncWorkboardAgentEnded({
      store,
      event: { runId: "run-agent", success: true },
      context: { runId: "run-agent", sessionKey },
      now: card.updatedAt + 3,
      readSessions,
    });
    await expect(store.get(card.id)).resolves.toMatchObject({ status: "running" });

    // The run-level terminal owner settles the exhausted run as blocked.
    await syncWorkboardSubagentEnded({
      store,
      event: {
        targetSessionKey: sessionKey,
        runId: "run-agent",
        endedAt: card.updatedAt + 4,
        outcome: "error",
      },
      now: card.updatedAt + 4,
    });
    await expect(store.get(card.id)).resolves.toMatchObject({
      status: "blocked",
      execution: { status: "blocked" },
      metadata: { failureCount: 1 },
    });
  });

  it("reviews immediately when agent_end succeeds after the run settled", async () => {
    const store = createWorkboardSqliteTestStore();
    const sessionKey = "agent:worker:subagent:workboard-ops-settled-success";
    const card = await createLinkedCard(store, {
      sessionKey,
      runId: "run-agent",
      execution: execution(sessionKey, "run-agent"),
    });
    const readSessions = vi.fn().mockResolvedValue({
      sessions: [
        { key: sessionKey, status: "done", hasActiveRun: false, updatedAt: card.updatedAt + 1 },
      ],
      complete: true,
    });

    await syncWorkboardAgentEnded({
      store,
      event: { runId: "run-agent", success: true },
      context: { runId: "run-agent", sessionKey },
      now: card.updatedAt + 2,
      readSessions,
    });

    expect(readSessions).toHaveBeenCalledOnce();
    await expect(store.get(card.id)).resolves.toMatchObject({
      status: "review",
      execution: { status: "review" },
    });
  });

  it("does not discover sessions when no cards match the agent_end hook", async () => {
    const store = createWorkboardSqliteTestStore();
    await createLinkedCard(store, {
      sessionKey: "agent:worker:subagent:workboard-ops-other",
      runId: "run-other",
    });
    const readSessions = vi.fn();

    await syncWorkboardAgentEnded({
      store,
      event: { runId: "run-unrelated", success: true },
      context: { runId: "run-unrelated", sessionKey: "agent:worker:subagent:workboard-ops-none" },
      readSessions,
    });

    expect(readSessions).not.toHaveBeenCalled();
  });

  it("defers the automation nudge for a successful attempt held for a live run", async () => {
    const store = createWorkboardSqliteTestStore();
    const sessionKey = "agent:worker:subagent:workboard-ops-deferred-nudge";
    const card = await createLinkedCard(store, {
      sessionKey,
      runId: "run-agent",
      execution: execution(sessionKey, "run-agent"),
    });
    const readSessions = vi.fn().mockResolvedValue({
      sessions: [{ key: sessionKey, status: "running", hasActiveRun: true }],
      complete: true,
    });
    const onMatched = vi.fn().mockResolvedValue(undefined);

    await syncWorkboardAgentEnded({
      store,
      event: { runId: "run-agent", success: true },
      context: { runId: "run-agent", sessionKey },
      now: card.updatedAt + 2,
      readSessions,
      onMatched,
    });

    expect(onMatched.mock.calls[0]?.[0].cards).toEqual([]);
    await expect(store.get(card.id)).resolves.toMatchObject({ status: "running" });

    // The run-level end hook settles the card and carries the nudge.
    await syncWorkboardSubagentEnded({
      store,
      event: {
        targetSessionKey: sessionKey,
        runId: "run-agent",
        endedAt: card.updatedAt + 3,
        outcome: "ok",
      },
      now: card.updatedAt + 3,
      onMatched,
    });

    expect(onMatched.mock.calls[1]?.[0].cards.map((c: { id: string }) => c.id)).toEqual([card.id]);
    await expect(store.get(card.id)).resolves.toMatchObject({ status: "review" });
  });

  it("nudges automation when the sweep settles a deferred completion", async () => {
    const store = createWorkboardSqliteTestStore();
    const sessionKey = "agent:main:dashboard:settled-by-sweep";
    const card = await createLinkedCard(store, { status: "running", sessionKey });
    const readSessions = vi.fn().mockResolvedValue({
      sessions: [
        { key: sessionKey, status: "done", hasActiveRun: false, updatedAt: card.updatedAt + 1 },
      ],
      complete: true,
    });
    const onSettled = vi.fn().mockResolvedValue(undefined);
    const service = createWorkboardLifecycleService({ store, readSessions, onSettled });
    const runOperation = vi.spyOn(store, "runOperation");
    const context = { logger: { warn: vi.fn() } } as never;
    try {
      await service.start(context);
      service.onGatewayStart();
      await runOperation.mock.results[0]?.value;
    } finally {
      service.onGatewayStop();
      await service.stop?.(context);
      runOperation.mockRestore();
    }

    expect(onSettled).toHaveBeenCalledOnce();
    expect(onSettled.mock.calls[0]?.[0].cards.map((c: { id: string }) => c.id)).toEqual([card.id]);
    await expect(store.get(card.id)).resolves.toMatchObject({ status: "review" });
  });
});
