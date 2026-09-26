// @vitest-environment node
import "../../test/host.setup.ts";
import { describe, expect, it } from "vitest";
import { getWorkboardLifecycle } from "./lifecycle.ts";
import { loadWorkboard, refreshWorkboard } from "./loading.ts";
import { getWorkboardState, resetWorkboardConnectionState } from "./runtime.ts";
import {
  createGatewaySession,
  createWorkboardCard,
  createWorkboardTestClient,
} from "./test/index-helpers.ts";

describe("Workboard native owners", () => {
  it("loads canonical cards without querying a task ledger", async () => {
    const host = {};
    const card = createWorkboardCard();
    const client = createWorkboardTestClient({
      "workboard.cards.list": { cards: [card], boards: [] },
    });
    expect(await loadWorkboard({ host, client })).toBe(true);
    expect(getWorkboardState(host).cards).toEqual([card]);
    expect(client.request.mock.calls.map(([method]) => method)).toEqual(["workboard.cards.list"]);
  });

  it("refreshes server diagnostics before reading cards", async () => {
    const host = {};
    const client = createWorkboardTestClient({ "workboard.cards.list": { cards: [], boards: [] } });
    expect(
      await refreshWorkboard({ host, client, source: "manual", refreshDiagnostics: true }),
    ).toBe(true);
    expect(client.request.mock.calls.map(([method]) => method)).toEqual([
      "workboard.cards.diagnostics.refresh",
      "workboard.cards.list",
    ]);
  });

  it("requires a canonical reload after disconnect before writes", () => {
    const host = {};
    const state = getWorkboardState(host);
    state.loaded = true;
    state.cards = [createWorkboardCard()];
    resetWorkboardConnectionState(host);
    expect(state.loaded).toBe(false);
    expect(state.mutationReadiness).toBe("canonical_reload_required");
    expect(state.cards).toHaveLength(1);
  });

  it.each([
    ["running", "running"],
    ["queued", "queued"],
    ["done", "succeeded"],
    ["failed", "failed"],
  ] as const)("derives %s lifecycle from the native session", (status, expected) => {
    const session = createGatewaySession({ status, hasActiveRun: status === "running" });
    const card = createWorkboardCard({ sessionKey: session.key });
    expect(getWorkboardLifecycle(card, [session]).state).toBe(expected);
  });
});
