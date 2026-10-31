import { WORKBOARD_STATUSES } from "@openclaw/workboard-contract";
import { expect, it } from "vitest";
import { registerWorkboardGatewayMethods } from "./gateway.js";
import { createGatewayMethodCapture } from "./test/gateway-method-capture.js";
import { createWorkboardSqliteTestHarness } from "./test/sqlite-store.js";

// Interleaved statuses keep a filtered page distinguishable from the
// unfiltered first page, and the 102 done cards exceed one unfiltered page so
// completed history has to be traversed without a selection.
const TOTAL_CARDS = 108;
const TODO_INDEXES = new Set([3, 20, 61, 101, 103, 106]);
const cardId = (index: number) => `card-${String(index).padStart(3, "0")}`;
const ALL_IDS = Array.from({ length: TOTAL_CARDS }, (_, index) => cardId(index));
const TODO_IDS = ALL_IDS.filter((_, index) => TODO_INDEXES.has(index));
const DONE_IDS = ALL_IDS.filter((_, index) => !TODO_INDEXES.has(index));
const CARD_FIELDS = {
  priority: "normal",
  labels: [] as string[],
  position: 0,
  createdAt: 1,
  updatedAt: 1,
} as const;

type ListReply = {
  ok: boolean;
  data: {
    cards?: Array<{ id: string; status: string }>;
    statuses?: readonly string[];
    boards?: Array<{ id: string; total: number; byStatus: Record<string, number> }>;
    revision?: { statuses?: readonly string[]; revision?: number };
    nextCursor?: { position: number; createdAt: number; id: string };
    unchanged?: boolean;
  };
  error?: { code?: string; message?: string };
};

function setupCardsList() {
  const { store, stores } = createWorkboardSqliteTestHarness();
  const { api, invoke } = createGatewayMethodCapture();
  registerWorkboardGatewayMethods({ api, store });
  const list = async (params: Record<string, unknown>): Promise<ListReply> => {
    const respond = await invoke("workboard.cards.list", params);
    const call = respond.mock.calls[0];
    return {
      ok: call?.[0] === true,
      data: call?.[1] ?? {},
      error: call?.[2],
    };
  };
  const seed = async () => {
    for (let index = 0; index < TOTAL_CARDS; index++) {
      const id = cardId(index);
      const done = !TODO_INDEXES.has(index);
      await stores.cards.register(id, {
        version: 1,
        card: {
          id,
          title: id,
          status: done ? "done" : "todo",
          ...CARD_FIELDS,
          metadata: {
            comments: [
              {
                id: `${id}-comment`,
                body: done ? `DONE_ONLY_${id}` : `TODO_COMMENT_${id}`,
                createdAt: 1,
              },
            ],
          },
        },
      });
    }
  };
  return { list, seed };
}

it("filters cards.list by a status selection and keeps board summaries population-wide", async () => {
  const { list, seed } = setupCardsList();
  await seed();

  const filtered = await list({ status: ["todo"] });
  expect(filtered.ok).toBe(true);
  expect(filtered.data.cards?.map((card) => card.id)).toEqual(TODO_IDS);
  expect(filtered.data.cards?.every((card) => card.status === "todo")).toBe(true);
  expect(filtered.data.statuses).toEqual([...WORKBOARD_STATUSES]);
  expect(filtered.data.revision?.statuses).toEqual(["todo"]);
  const defaultBoard = filtered.data.boards?.find((board) => board.id === "default");
  expect(defaultBoard?.total).toBe(TOTAL_CARDS);
  expect(defaultBoard?.byStatus).toEqual({ todo: TODO_IDS.length, done: DONE_IDS.length });

  // Selection happens before child hydration: no completed card body or
  // completed card comment reaches a selected-only payload.
  expect(JSON.stringify(filtered.data)).not.toContain("DONE_ONLY_");

  const unfiltered = await list({});
  expect(unfiltered.ok).toBe(true);
  expect(unfiltered.data.cards).toHaveLength(100);
  expect(unfiltered.data.revision?.statuses).toBeUndefined();
  expect(JSON.stringify(unfiltered.data)).toContain("DONE_ONLY_card-000");

  // One contract: a single status and a status set select the same cards.
  const scalar = await list({ status: "todo" });
  expect(scalar.ok).toBe(true);
  expect(scalar.data.cards?.map((card) => card.id)).toEqual(TODO_IDS);
});

it("continues a filtered page across completed history larger than one page", async () => {
  const { list, seed } = setupCardsList();
  await seed();

  const first = await list({ status: ["done"] });
  expect(first.ok).toBe(true);
  expect(first.data.cards?.map((card) => card.id)).toEqual(DONE_IDS.slice(0, 100));
  expect(first.data.cards?.every((card) => card.status === "done")).toBe(true);
  expect(first.data.nextCursor).toBeDefined();

  const second = await list({ status: ["done"], after: first.data.nextCursor });
  expect(second.ok).toBe(true);
  expect(second.data.cards?.map((card) => card.id)).toEqual(DONE_IDS.slice(100));
  expect(second.data.cards?.every((card) => card.status === "done")).toBe(true);
  expect(second.data.nextCursor).toBeUndefined();

  const visited = [...(first.data.cards ?? []), ...(second.data.cards ?? [])].map(
    (card) => card.id,
  );
  expect(visited).toEqual(DONE_IDS);
  expect(new Set(visited).size).toBe(DONE_IDS.length);
});

it("keeps status-scoped caches and revision receipts isolated from unfiltered reads", async () => {
  const { list, seed } = setupCardsList();
  await seed();

  const filtered = await list({ status: ["todo"] });
  expect(filtered.data.cards?.map((card) => card.id)).toEqual(TODO_IDS);

  const unfilteredFirst = await list({});
  expect(unfilteredFirst.data.cards).toHaveLength(100);
  expect(unfilteredFirst.data.cards?.some((card) => card.status === "done")).toBe(true);

  // Repeats hit their own cache entries: neither payload is served from the
  // other selection's cached page.
  const filteredAgain = await list({ status: ["todo"] });
  expect(filteredAgain.data).toBe(filtered.data);
  const unfilteredAgain = await list({});
  expect(unfilteredAgain.data).toBe(unfilteredFirst.data);

  const unchanged = await list({
    status: ["todo"],
    sinceRevision: filtered.data.revision,
  });
  expect(unchanged.data).toEqual({ unchanged: true, revision: filtered.data.revision });

  const crossFromFiltered = await list({ sinceRevision: filtered.data.revision });
  expect(crossFromFiltered.data.unchanged).toBeUndefined();
  expect(crossFromFiltered.data.cards).toHaveLength(100);

  const crossFromUnfiltered = await list({
    status: ["todo"],
    sinceRevision: unfilteredFirst.data.revision,
  });
  expect(crossFromUnfiltered.data.unchanged).toBeUndefined();
  expect(crossFromUnfiltered.data.cards?.map((card) => card.id)).toEqual(TODO_IDS);
});

it("rejects status selections outside the Workboard status vocabulary", async () => {
  const { list, seed } = setupCardsList();
  await seed();

  const unknownValue = await list({ status: ["nonsense"] });
  expect(unknownValue.ok).toBe(false);
  expect(unknownValue.error?.code).toBe("workboard_error");
  expect(unknownValue.error?.message).toContain('"triage"');
  expect(unknownValue.error?.message).toContain('"done"');

  const unknownScalar = await list({ status: "nonsense" });
  expect(unknownScalar.ok).toBe(false);
  expect(unknownScalar.error?.message).toContain('"todo"');

  const emptySet = await list({ status: [] });
  expect(emptySet.ok).toBe(false);
  expect(emptySet.error?.message).toContain("Too small");

  // A rejected selection never degrades into an unfiltered full-board read.
  const stillUnfiltered = await list({});
  expect(stillUnfiltered.ok).toBe(true);
  expect(stillUnfiltered.data.cards).toHaveLength(100);
});
