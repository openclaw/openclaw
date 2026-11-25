import "../../test/dom.setup.ts";
import { expectDefined } from "@openclaw/normalization-core";
import { createDeferred } from "openclaw/plugin-sdk/concurrency-runtime";
import { expect, it, vi } from "vitest";
import { setWorkboardCards } from "../../lib/workboard/card-state.ts";
import { createWorkboardCard as makeCard } from "../../lib/workboard/test/index-helpers.ts";
import { type SelectPicker, requireButton } from "./view.test-support.ts";
import { mountPage } from "./workboard-page.test-support.ts";

async function mountSelection(action: "update" | "archive", scoped = false) {
  const method = `workboard.cards.${action}`;
  const page = mountPage({ boardId: "one" });
  const state = page.workboard.state;
  const first = makeCard({ agentId: "writer", metadata: { automation: { boardId: "one" } } });
  const second = makeCard({ ...first, id: "second", position: 2000 });
  const pending = createDeferred<{ card: typeof first }>();
  const request = expectDefined(page.request.getMockImplementation(), "request implementation");
  page.request.mockImplementation((name, params) =>
    name === method ? pending.promise : request(name, params),
  );
  page.cards([first, second]);
  if (scoped) {
    page.fixture.host.agents.setScope("writer");
  }
  page.fixture.connection.connected = true;
  page.fixture.notify();
  await vi.waitFor(() => expect(state.loaded).toBe(true));
  state.selectedCardIds = new Set([first.id, second.id]);
  state.query = "unmatched";
  state.statusFilter = new Set(["done"]);
  const writes = () => page.request.mock.calls.filter(([name]) => name === method);
  return { page, state, first, second, pending, writes };
}

it("stops a bulk assignment after board scope changes while the first write is pending", async () => {
  const { page, state, first, second, pending, writes } = await mountSelection("update");
  page.workboard.notify();
  const picker = await vi.waitFor(() =>
    expectDefined(
      [
        ...page.container.querySelectorAll<SelectPicker>(
          ".workboard-selection [data-test-select-picker]",
        ),
      ].find((item) => item.accessibleLabel === "Assign agent…"),
      "bulk assignment",
    ),
  );
  expect(state.selectedCardIds).toEqual(new Set([first.id, second.id]));
  picker.onSelect("main");
  await vi.waitFor(() => expect(writes()).toHaveLength(1));
  expect(state.bulkSaving).toBe(true);
  page.navigate("two");
  await vi.waitFor(() => expect(state.selectedCardIds.size).toBe(0));
  page.navigate("one");
  await vi.waitFor(() => expect(state.boardFilter).toBe("one"));
  const patch = { agentId: "main" };
  pending.resolve({ card: { ...first, ...patch, updatedAt: first.updatedAt + 1 } });
  await vi.waitFor(() => expect(state.bulkSaving).toBe(false));
  const update = { id: first.id, expectedUpdatedAt: first.updatedAt, patch };
  expect(writes()).toEqual([["workboard.cards.update", update]]);
  expect(state.cards.find((card) => card.id === first.id)?.agentId).toBe("main");
  expect(state.cards.find((card) => card.id === second.id)?.agentId).toBe("writer");
  expect(state.selectedCardIds.size).toBe(0);
});

it("drops a selected card made ineligible by agent scope while bulk work is pending", async () => {
  const { page, state, first, second, pending, writes } = await mountSelection("archive", true);
  const outside = { ...second, agentId: "main", updatedAt: second.updatedAt + 1 };
  setWorkboardCards(state, [first, outside]);
  page.workboard.notify();
  await vi.waitFor(() => expect(state.selectedCardIds).toEqual(new Set([first.id])));
  setWorkboardCards(state, [first, second]);
  state.selectedCardIds.add(second.id);
  page.workboard.notify();
  const archive = await vi.waitFor(() =>
    requireButton(
      expectDefined(page.container.querySelector(".workboard-selection"), "selection"),
      "Archive",
    ),
  );
  archive.click();
  await vi.waitFor(() => expect(writes()).toHaveLength(1));
  setWorkboardCards(state, [first, outside]);
  page.workboard.notify();
  await vi.waitFor(() => expect(state.selectedCardIds).toEqual(new Set([first.id])));
  pending.resolve({
    card: { ...first, metadata: { ...first.metadata, archivedAt: first.updatedAt + 1 } },
  });
  await vi.waitFor(() => expect(state.bulkSaving).toBe(false));
  expect(writes()).toHaveLength(1);
  expect(state.cards.find((card) => card.id === second.id)).toEqual(outside);
  expect(state.selectedCardIds.size).toBe(0);
});
