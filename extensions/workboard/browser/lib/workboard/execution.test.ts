// @vitest-environment node
import "../../test/host.setup.ts";
import { describe, expect, it } from "vitest";
import { startWorkboardCard, stopWorkboardCard, workboardStartBlockReason } from "./execution.ts";
import { getWorkboardState } from "./runtime.ts";
import { createWorkboardCard, createWorkboardTestClient } from "./test/index-helpers.ts";

describe("Workboard native execution", () => {
  it("starts through the card owner and uses its accepted session", async () => {
    const host = {};
    const card = createWorkboardCard();
    const started = {
      ...card,
      status: "running",
      sessionKey: "agent:main:subagent:worker",
      runId: "run-1",
    };
    const state = getWorkboardState(host);
    state.loaded = true;
    state.cards = [card];
    const client = createWorkboardTestClient({ "workboard.cards.start": { card: started } });
    expect(await startWorkboardCard({ host, client, card })).toBe(started.sessionKey);
    expect(client.request.mock.calls.map(([method]) => method)).toEqual(["workboard.cards.start"]);
    expect(state.cards[0]?.runId).toBe("run-1");
  });

  it.each([
    ["missing date", { status: "scheduled" as const }, "missingSchedule"],
    [
      "future date",
      { status: "scheduled" as const, metadata: { automation: { scheduledAt: 2000 } } },
      "futureSchedule",
    ],
    [
      "past date",
      { status: "scheduled" as const, metadata: { automation: { scheduledAt: 500 } } },
      undefined,
    ],
    ["linked session", { sessionKey: "agent:main:dashboard:worker" }, "linked"],
  ])("aligns start admission for %s", async (_label, overrides, reason) => {
    const card = createWorkboardCard(overrides);
    expect(workboardStartBlockReason(card, "autonomous", 1000)).toBe(reason);
  });

  it("rejects missing and future schedules without sending a start request", async () => {
    for (const card of [
      createWorkboardCard({ status: "scheduled" }),
      createWorkboardCard({
        status: "scheduled",
        metadata: { automation: { scheduledAt: Date.now() + 60_000 } },
      }),
    ]) {
      const host = {};
      const state = getWorkboardState(host);
      state.loaded = true;
      state.cards = [card];
      const client = createWorkboardTestClient({});
      expect(await startWorkboardCard({ host, client, card })).toBeNull();
      expect(client.request).not.toHaveBeenCalled();
      expect(state.error).toContain(card.metadata ? "future time" : "without a date");
    }
  });

  it("starts a past schedule and rejects an existing session", async () => {
    for (const linked of [false, true]) {
      const host = {};
      const card = createWorkboardCard({
        status: "scheduled",
        metadata: { automation: { scheduledAt: Date.now() - 1000 } },
        ...(linked ? { sessionKey: "agent:main:dashboard:existing" } : {}),
      });
      const state = getWorkboardState(host);
      state.loaded = true;
      state.cards = [card];
      const client = createWorkboardTestClient({
        "workboard.cards.start": { card: { ...card, sessionKey: "agent:main:dashboard:new" } },
      });
      expect(await startWorkboardCard({ host, client, card })).toBe(
        linked ? null : "agent:main:dashboard:new",
      );
      expect(client.request).toHaveBeenCalledTimes(linked ? 0 : 1);
    }
  });

  it("opens manually only on explicit action and clears the schedule", async () => {
    const host = {};
    const card = createWorkboardCard({
      status: "scheduled",
      metadata: { automation: { scheduledAt: Date.now() + 60_000 } },
    });
    const state = getWorkboardState(host);
    state.loaded = true;
    state.cards = [card];
    const client = createWorkboardTestClient({
      "sessions.create": { key: "agent:main:dashboard:manual" },
      "workboard.cards.update": {
        card: { ...card, status: "todo", sessionKey: "agent:main:dashboard:manual" },
      },
    });
    expect(workboardStartBlockReason(card, "manual")).toBeUndefined();
    expect(await startWorkboardCard({ host, client, card, mode: "manual" })).toBe(
      "agent:main:dashboard:manual",
    );
    expect(client.request.mock.calls[1]?.[1]).toMatchObject({
      patch: { status: "todo", scheduledAt: null },
    });
  });

  it("aborts the recorded native session run before updating the card", async () => {
    const host = {};
    const card = createWorkboardCard({
      status: "running",
      sessionKey: "agent:main:dashboard:worker",
      runId: "run-1",
    });
    const state = getWorkboardState(host);
    state.loaded = true;
    state.cards = [card];
    const client = createWorkboardTestClient({
      "chat.abort": { aborted: true },
      "workboard.cards.update": { card: { ...card, status: "blocked" } },
    });
    await stopWorkboardCard({ host, client, card });
    expect(client.request.mock.calls.map(([method]) => method)).toEqual([
      "chat.abort",
      "workboard.cards.update",
    ]);
    expect(client.request.mock.calls[0]?.[1]).toMatchObject({ runId: "run-1" });
    expect(state.cards[0]?.status).toBe("blocked");
  });

  it("does not claim cancellation when the native owner aborted nothing", async () => {
    const host = {};
    const card = createWorkboardCard({
      sessionKey: "agent:main:dashboard:worker",
      runId: "finished-run",
    });
    const state = getWorkboardState(host);
    state.loaded = true;
    state.cards = [card];
    const client = createWorkboardTestClient({ "chat.abort": { aborted: false } });
    await stopWorkboardCard({ host, client, card });
    expect(client.request.mock.calls.map(([method]) => method)).toEqual([
      "chat.abort",
      "chat.abort",
    ]);
    expect(state.cards[0]).toEqual(card);
  });
});
