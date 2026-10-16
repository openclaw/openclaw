import "../../test/dom.setup.ts";
import { expectDefined } from "@openclaw/normalization-core";
import type { ControlUiComponents } from "openclaw/plugin-sdk/control-ui";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { expect, it, vi } from "vitest";
import { setWorkboardCards } from "../../lib/workboard/card-state.ts";
import { createWorkboardCard } from "../../lib/workboard/test/index-helpers.ts";
import { mountPage } from "./workboard-page.test-support.ts";

type ControlUiSelectPickerProps = Parameters<ControlUiComponents["mountSelectPicker"]>[1];

it("stops a bulk assignment after board scope changes while the first write is pending", async () => {
  const page = mountPage({ boardId: "one" });
  const state = page.workboard.state;
  const first = createWorkboardCard({
    id: "first",
    agentId: "writer",
    metadata: { automation: { boardId: "one" } },
  });
  const second = createWorkboardCard({ ...first, id: "second", position: 2000 });
  const firstWrite = createDeferred<{ card: typeof first }>();
  const request = expectDefined(page.request.getMockImplementation(), "request implementation");
  page.request.mockImplementation((method, params) =>
    method === "workboard.cards.update" ? firstWrite.promise : request(method, params),
  );
  page.cards([first, second]);
  page.fixture.connection.connected = true;
  page.fixture.notify();
  await vi.waitFor(() => expect(state.loaded).toBe(true));
  state.selectedCardIds = new Set([first.id, second.id]);
  state.query = "unmatched";
  state.statusFilter = new Set(["done"]);
  page.workboard.notify();
  const picker = await vi.waitFor(() =>
    expectDefined(
      [
        ...page.container.querySelectorAll<HTMLElement & ControlUiSelectPickerProps>(
          ".workboard-selection [data-test-select-picker]",
        ),
      ].find((item) => item.accessibleLabel === "Assign agent…"),
      "bulk assignment",
    ),
  );
  expect(state.selectedCardIds).toEqual(new Set([first.id, second.id]));
  picker.onSelect("main");
  await vi.waitFor(() =>
    expect(
      page.request.mock.calls.filter(([method]) => method === "workboard.cards.update"),
    ).toHaveLength(1),
  );
  expect(state.bulkSaving).toBe(true);
  page.navigate("two");
  await vi.waitFor(() => expect(state.selectedCardIds.size).toBe(0));
  expect(state.bulkDialog).toBeNull();
  page.navigate("one");
  await vi.waitFor(() => expect(state.boardFilter).toBe("one"));
  firstWrite.resolve({ card: { ...first, agentId: "main", updatedAt: first.updatedAt + 1 } });
  await vi.waitFor(() => expect(state.bulkSaving).toBe(false));
  expect(page.request.mock.calls.filter(([method]) => method === "workboard.cards.update")).toEqual(
    [
      [
        "workboard.cards.update",
        { id: first.id, expectedUpdatedAt: first.updatedAt, patch: { agentId: "main" } },
      ],
    ],
  );
  expect(state.cards.find((card) => card.id === first.id)?.agentId).toBe("main");
  expect(state.cards.find((card) => card.id === second.id)?.agentId).toBe("writer");
  expect(state.selectedCardIds.size).toBe(0);
});

it("drops a selected card made ineligible by agent scope while bulk work is pending", async () => {
  const page = mountPage({ boardId: "one" });
  const state = page.workboard.state;
  const first = createWorkboardCard({
    id: "first",
    agentId: "writer",
    metadata: { automation: { boardId: "one" } },
  });
  const second = createWorkboardCard({ ...first, id: "second", position: 2000 });
  const outside = { ...second, agentId: "main", updatedAt: second.updatedAt + 1 };
  const pending = createDeferred<{ card: typeof first }>();
  const request = expectDefined(page.request.getMockImplementation(), "request implementation");
  page.request.mockImplementation((method, params) =>
    method === "workboard.cards.archive" ? pending.promise : request(method, params),
  );
  page.cards([first, second]);
  page.fixture.host.agents.setScope("writer");
  page.fixture.connection.connected = true;
  page.fixture.notify();
  await vi.waitFor(() => expect(state.loaded).toBe(true));
  state.selectedCardIds = new Set([first.id, second.id]);
  state.query = "unmatched";
  state.statusFilter = new Set(["done"]);
  setWorkboardCards(state, [first, outside]);
  page.workboard.notify();
  await vi.waitFor(() => expect(state.selectedCardIds).toEqual(new Set([first.id])));
  setWorkboardCards(state, [first, second]);
  state.selectedCardIds.add(second.id);
  page.workboard.notify();
  const archive = await vi.waitFor(() =>
    expectDefined(
      [...page.container.querySelectorAll<HTMLButtonElement>(".workboard-selection button")].find(
        (button) => button.textContent?.trim() === "Archive",
      ),
      "archive selection",
    ),
  );
  archive.click();
  await vi.waitFor(() =>
    expect(
      page.request.mock.calls.filter(([method]) => method === "workboard.cards.archive"),
    ).toHaveLength(1),
  );
  setWorkboardCards(state, [first, outside]);
  page.workboard.notify();
  await vi.waitFor(() => expect(state.selectedCardIds).toEqual(new Set([first.id])));
  pending.resolve({
    card: { ...first, metadata: { ...first.metadata, archivedAt: first.updatedAt + 1 } },
  });
  await vi.waitFor(() => expect(state.bulkSaving).toBe(false));
  expect(
    page.request.mock.calls.filter(([method]) => method === "workboard.cards.archive"),
  ).toHaveLength(1);
  expect(state.cards.find((card) => card.id === second.id)).toEqual(outside);
  expect(state.selectedCardIds.size).toBe(0);
});
