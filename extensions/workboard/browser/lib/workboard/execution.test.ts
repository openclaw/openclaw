// @vitest-environment node
import "../../test/host.setup.ts";
import { describe, expect, it } from "vitest";
import { startWorkboardCard, stopWorkboardCard } from "./execution.ts";
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
