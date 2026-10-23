// @vitest-environment node
import "../../test/host.setup.ts";
import { createDeferred } from "openclaw/plugin-sdk/concurrency-runtime";
import { expect, it } from "vitest";
import { getWorkboardDependencyState } from "./card-state.ts";
import { getWorkboardLifecycle } from "./lifecycle.ts";
import { loadWorkboard, refreshWorkboard } from "./loading.ts";
import { moveWorkboardCard, updateWorkboardCardProperties } from "./mutations.ts";
import { getWorkboardState, resetWorkboardConnectionState } from "./runtime.ts";
import {
  createGatewaySession,
  createWorkboardCard,
  createWorkboardTestClient,
} from "./test/index-helpers.ts";

function setup(responses: Parameters<typeof createWorkboardTestClient>[0] = {}) {
  const host = {};
  const client = createWorkboardTestClient(responses);
  const methods = () => client.request.mock.calls.map(([method]) => method);
  return { ctx: { host, client }, state: getWorkboardState(host), methods };
}

it("loads another bounded page on demand and refreshes the held window", async () => {
  const first = createWorkboardCard();
  const second = createWorkboardCard({ id: "card-2", position: 2000 });
  const cursor = { id: first.id, position: first.position, createdAt: first.createdAt };
  let firstTitle = first.title;
  const { ctx, state, methods } = setup((_method, params) => {
    // SAFETY: this fixture receives only the cards-list request shape.
    const { after } = params as { after?: typeof cursor };
    return after
      ? { cards: [second], boards: [] }
      : { cards: [{ ...first, title: firstTitle }], boards: [], nextCursor: cursor };
  });
  expect(await loadWorkboard(ctx)).toBe(true);
  expect(state.cards).toEqual([first]);
  expect(state.nextCursor).toEqual(cursor);
  expect(methods()).toEqual(["workboard.cards.list"]);
  await loadWorkboard({ ...ctx, more: true });
  expect(state.cards.map((card) => card.id)).toEqual([first.id, second.id]);
  expect(state.nextCursor).toBeNull();
  firstTitle = "Fresh title";
  await refreshWorkboard({ ...ctx, source: "manual" });
  expect(state.cards.map((card) => card.title)).toEqual([firstTitle, second.title]);
  expect(state.nextCursor).toBeNull();
});

it("does not mark a dependency outside the loaded page missing or block its card", () => {
  const card = createWorkboardCard({
    metadata: {
      links: [{ id: "parent-link", type: "parent", targetCardId: "not-loaded", createdAt: 1 }],
    },
  });
  const partial = getWorkboardDependencyState(card, [card], false);
  expect(partial.parents).toEqual([expect.objectContaining({ missing: false })]);
  expect(partial.blockedParents).toEqual([]);
  expect(getWorkboardDependencyState(card, [card]).blockedParents).toHaveLength(1);
});

it("refreshes server diagnostics before reading cards", async () => {
  const { ctx, methods } = setup({ "workboard.cards.list": { cards: [], boards: [] } });
  expect(await refreshWorkboard({ ...ctx, source: "manual", refreshDiagnostics: true })).toBe(true);
  expect(methods()).toEqual(["workboard.cards.diagnostics.refresh", "workboard.cards.list"]);
});

it("requires a canonical reload after disconnect before writes", () => {
  const { ctx, state } = setup();
  state.loaded = true;
  state.cards = [createWorkboardCard()];
  resetWorkboardConnectionState(ctx.host);
  expect(state).toMatchObject({ loaded: false, mutationReadiness: "canonical_reload_required" });
  expect(state.cards).toHaveLength(1);
});

it("reserves every reordered card until the ordered move settles", async () => {
  const moving = createWorkboardCard({ id: "moving", position: 2000 });
  const peer = createWorkboardCard({ id: "peer", position: 0 });
  const shifted = { ...peer, position: 1999, updatedAt: 2 };
  const moved = { ...moving, position: 999, updatedAt: 2 };
  const pending = createDeferred<{ card: typeof peer }>();
  const { ctx, state, methods } = setup((method) =>
    method === "workboard.cards.update" ? pending.promise : { card: moved },
  );
  state.cards = [peer, moving];
  const move = moveWorkboardCard({
    ...ctx,
    cardId: moving.id,
    status: "todo",
    beforeCardId: peer.id,
    boardFilter: "__all__",
  });
  expect(await updateWorkboardCardProperties({ ...ctx, card: peer, patch: { title: "X" } })).toBe(
    false,
  );
  expect(ctx.client.request).toHaveBeenCalledTimes(1);
  pending.resolve({ card: shifted });
  await move;
  expect(state.cards).toEqual([moved, shifted]);
  expect(state.busyCardIds.size).toBe(0);
  expect(methods()).toEqual(["workboard.cards.update", "workboard.cards.move"]);
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
