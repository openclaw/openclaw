// @vitest-environment node
import "../../test/host.setup.ts";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { describe, expect, it } from "vitest";
import { getWorkboardLifecycle } from "./lifecycle.ts";
import { loadWorkboard, refreshWorkboard } from "./loading.ts";
import { moveWorkboardCard, updateWorkboardCardProperties } from "./mutations.ts";
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

  it("reserves every reordered card until the ordered move settles", async () => {
    const host = {};
    const moving = createWorkboardCard({ id: "moving", position: 2000 });
    const peer = createWorkboardCard({ id: "peer", position: 0 });
    const shifted = { ...peer, position: 1999, updatedAt: 2 };
    const moved = { ...moving, position: 999, updatedAt: 2 };
    const pending = createDeferred<{ card: typeof peer }>();
    const client = createWorkboardTestClient((method) =>
      method === "workboard.cards.update" ? pending.promise : { card: moved },
    );
    const state = getWorkboardState(host);
    state.cards = [peer, moving];
    const move = moveWorkboardCard({
      host,
      client,
      cardId: moving.id,
      status: "todo",
      beforeCardId: peer.id,
      boardFilter: "__all__",
    });
    expect(
      await updateWorkboardCardProperties({ host, client, card: peer, patch: { title: "X" } }),
    ).toBe(false);
    expect(client.request).toHaveBeenCalledTimes(1);
    pending.resolve({ card: shifted });
    await move;
    expect(state.cards).toEqual([moved, shifted]);
    expect(state.busyCardIds.size).toBe(0);
    expect(client.request.mock.calls.map(([method]) => method)).toEqual([
      "workboard.cards.update",
      "workboard.cards.move",
    ]);
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
