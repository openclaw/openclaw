import "../../test/dom.setup.ts";
import { describe, expect, it, vi } from "vitest";
import { createWorkboardCard } from "../../lib/workboard/test/index-helpers.ts";
import type { WorkboardBoardSummary, WorkboardStatus } from "../../lib/workboard/types.ts";
import { buttonByLabel, createWorkboardView, openCardMenu } from "./view.test-support.ts";

function board(overrides: Partial<WorkboardBoardSummary> = {}): WorkboardBoardSummary {
  return { id: "overview", total: 0, active: 0, archived: 0, byStatus: {}, ...overrides };
}

function card(id: string, status: WorkboardStatus, boardId = "overview") {
  return createWorkboardCard({
    id,
    title: `${id} card`,
    status,
    metadata: { automation: { boardId } },
  });
}

const columnTitles = (container: Element) =>
  Array.from(container.querySelectorAll(".workboard-column h2"), (heading) =>
    heading.textContent?.trim(),
  );

const statusTabs = (container: Element) =>
  Array.from(container.querySelectorAll(".workboard-status-tabs button"), (button) =>
    button.textContent?.trim(),
  );

describe("Cards board columns", () => {
  it("renders a board's visible statuses in order with labels and keeps hidden cards in Other statuses", () => {
    const { state, container, renderView } = createWorkboardView();
    state.boards = [
      board({
        columns: {
          visible: ["triage", "scheduled", "blocked", "done"],
          labels: { triage: "Todo", scheduled: "In progress", blocked: "Needs you" },
        },
      }),
    ];
    state.boardFilter = "overview";
    state.cards = [card("plan", "triage"), card("ship", "scheduled"), card("check", "review")];
    renderView({ client: { request: vi.fn() } });

    expect(columnTitles(container)).toEqual([
      "Todo",
      "In progress",
      "Needs you",
      "Done",
      "Other statuses",
    ]);
    const other = container.querySelector<HTMLElement>(".workboard-column--other");
    expect(other?.getAttribute("aria-label")).toBe("Other statuses, 1");
    expect(other?.textContent).toContain("Review");
    expect(other?.textContent).toContain("check card");
    expect(statusTabs(container)).toEqual(["All", "Todo", "In progress", "Needs you", "Done"]);
    // A card in a left-out status can still move into the board's columns.
    const move = openCardMenu(other!).querySelector<HTMLSelectElement>(
      ".workboard-card__move-select",
    );
    expect(Array.from(move?.options ?? [], (option) => option.textContent?.trim())).toEqual([
      "Review",
      "Todo",
      "In progress",
      "Needs you",
      "Done",
    ]);
  });

  it("keeps boards without columns and the All boards view on every default status", () => {
    const { state, container, renderView } = createWorkboardView();
    state.boards = [
      board({ id: "default" }),
      board({ columns: { visible: ["done"], labels: { done: "Shipped" } } }),
    ];
    state.cards = [card("plan", "triage", "default"), card("check", "review")];
    for (const boardFilter of ["default", "__all__"]) {
      state.boardFilter = boardFilter;
      renderView();
      expect(columnTitles(container)).toEqual([
        "Triage",
        "Backlog",
        "Todo",
        "Scheduled",
        "Ready",
        "Running",
        "Review",
        "Blocked",
        "Done",
      ]);
      expect(container.querySelector(".workboard-column--other")).toBeNull();
    }
  });

  it("applies the board's empty-column default until the viewer picks one", () => {
    const { state, container, renderView } = createWorkboardView({
      onRequestUpdate: () => undefined,
    });
    state.boards = [board({ columns: { visible: ["todo", "blocked"], emptyColumnMode: "hide" } })];
    state.boardFilter = "overview";
    state.cards = [card("plan", "todo")];
    renderView();
    expect(columnTitles(container)).toEqual(["Todo"]);
    expect(buttonByLabel(container, "Hide empty")?.getAttribute("aria-pressed")).toBe("true");
    buttonByLabel(container, "Show all")?.click();
    renderView();
    expect(state.emptyColumnMode).toBe("show");
    expect(columnTitles(container)).toEqual(["Todo", "Blocked"]);
  });
});
