import "../../test/dom.setup.ts";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { afterWorkboardUpdate } from "../../test/settle.ts";
import { mountPage, openBoardEditor } from "./workboard-page.test-support.ts";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function planningPage(columns?: unknown) {
  const page = mountPage({ boardId: "planning" });
  const request = expectDefined(page.request.getMockImplementation(), "request implementation");
  page.request.mockImplementation(async (method, params) =>
    method === "workboard.cards.list"
      ? {
          cards: [],
          boards: [
            {
              id: "planning",
              name: "Planning",
              total: 0,
              active: 0,
              archived: 0,
              byStatus: {},
              ...(columns ? { columns } : {}),
            },
          ],
        }
      : request(method, params),
  );
  page.fixture.connection.connected = true;
  page.fixture.notify();
  return page;
}

function row(form: HTMLElement, status: string) {
  return expectDefined(
    form.querySelector<HTMLElement>(`.workboard-columns-editor__row[data-status="${status}"]`),
    `${status} column row`,
  );
}

function input(element: HTMLInputElement, value: string | boolean) {
  if (typeof value === "boolean") {
    element.checked = value;
    element.dispatchEvent(new Event("change", { bubbles: true }));
  } else {
    element.value = value;
    element.dispatchEvent(new Event("input", { bubbles: true }));
  }
}

it("saves chosen, ordered and relabeled Cards board columns through boards.upsert", async () => {
  const page = planningPage();
  const form = await openBoardEditor(page);
  for (const status of ["backlog", "todo", "ready", "running", "review"]) {
    input(row(form, status).querySelector<HTMLInputElement>('input[type="checkbox"]')!, false);
  }
  input(row(form, "blocked").querySelector<HTMLInputElement>(".settings-input")!, "Needs you");
  await afterWorkboardUpdate(() => undefined);
  row(form, "blocked").querySelector<HTMLButtonElement>('[aria-label="Move Blocked up"]')!.click();
  await afterWorkboardUpdate(() => undefined);
  form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  await afterWorkboardUpdate(() =>
    expect(page.request).toHaveBeenCalledWith("workboard.boards.upsert", {
      id: "planning",
      columns: {
        visible: ["triage", "blocked", "scheduled", "done"],
        labels: { blocked: "Needs you" },
      },
    }),
  );
});

it("resets saved columns with null and leaves untouched columns out of the upsert", async () => {
  const page = planningPage({
    visible: ["done", "todo"],
    labels: { done: "Shipped" },
    emptyColumnMode: "show",
  });
  let form = await openBoardEditor(page);
  expect(
    form.querySelector<HTMLSelectElement>(".workboard-columns-editor select")?.selectedIndex,
  ).toBe(0);
  expect(
    Array.from(form.querySelectorAll<HTMLElement>(".workboard-columns-editor__row")).map(
      (element) => element.dataset.status,
    ),
  ).toEqual([
    "done",
    "todo",
    "triage",
    "backlog",
    "scheduled",
    "ready",
    "running",
    "review",
    "blocked",
  ]);
  input(form.querySelector<HTMLInputElement>(".workboard-board-draft__name input")!, "Renamed");
  form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  await afterWorkboardUpdate(() =>
    expect(page.request).toHaveBeenCalledWith("workboard.boards.upsert", {
      id: "planning",
      name: "Renamed",
    }),
  );

  form = await openBoardEditor(page);
  expectDefined(
    Array.from(form.querySelectorAll<HTMLButtonElement>("button")).find(
      (button) => button.textContent?.trim() === "Reset to all statuses",
    ),
    "reset button",
  ).click();
  await afterWorkboardUpdate(() => undefined);
  form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  await afterWorkboardUpdate(() =>
    expect(page.request).toHaveBeenCalledWith("workboard.boards.upsert", {
      id: "planning",
      columns: null,
    }),
  );
});
