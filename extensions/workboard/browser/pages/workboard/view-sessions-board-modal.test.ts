import "../../test/dom.setup.ts";
import { expectDefined } from "@openclaw/normalization-core";
import { createDefaultWorkboardSessionsBoardSpec } from "@openclaw/workboard-contract";
import { expect, it, onTestFinished, vi } from "vitest";
import { mountPage, openBoardEditor } from "./workboard-page.test-support.ts";

it("accepts padded board and column text up to each trimmed limit", async () => {
  vi.useFakeTimers();
  onTestFinished(() => {
    vi.useRealTimers();
  });
  const sessions = createDefaultWorkboardSessionsBoardSpec();
  const board = { id: "garden", kind: "sessions", name: "Garden", sessions };
  const page = mountPage({ boardId: board.id });
  const request = expectDefined(page.request.getMockImplementation(), "request");
  page.request.mockImplementation(async (method, params) => {
    if (method === "workboard.cards.list") {
      return { cards: [], boards: [{ ...board, total: 0, active: 0, archived: 0, byStatus: {} }] };
    }
    if (method === "workboard.sessionsBoard.read") {
      return { board, columns: sessions.columns, sessions: [], people: [] };
    }
    return request(method, params);
  });
  page.fixture.connection.connected = true;
  page.fixture.notify();
  const form = await openBoardEditor(page);
  const label = "🌱 Sweet basil seedlings for the lower herb garden in bed 12";
  const description = "🌱 ".padEnd(394, "x") + "bed 34";
  const name = "🌱 ".padEnd(114, "x") + "bed 56";
  const column = expectDefined(form.querySelector('[data-column-id="needs-input"]'), "column");

  function enter(field: HTMLInputElement | HTMLTextAreaElement | null, value: string) {
    const input = expectDefined(field, "text field");
    const raw = ` ${value}`;
    // Programmatic input skips the browser's raw length constraint on a paste.
    expect.soft(raw.length).toBeLessThanOrEqual(input.maxLength < 0 ? Infinity : input.maxLength);
    input.value = raw;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }

  const labelInput = column.querySelector<HTMLInputElement>('input[aria-label="Column label"]');
  enter(labelInput, `${label}x`);
  form.requestSubmit();
  await vi.advanceTimersByTimeAsync(0);
  expect(form.querySelector('[role="alert"]')?.textContent).toContain("column label");
  expect(page.request.mock.calls.map(([method]) => method)).not.toContain(
    "workboard.boards.upsert",
  );

  enter(form.querySelector<HTMLInputElement>(".workboard-board-draft__name input"), name);
  enter(labelInput, label);
  enter(column.querySelector("textarea"), description);
  form.requestSubmit();
  await vi.advanceTimersByTimeAsync(0);

  expect(page.request).toHaveBeenCalledWith("workboard.boards.upsert", { id: board.id, name });
  const columns = structuredClone(sessions.columns);
  const edited = expectDefined(
    columns.find((entry) => entry.id === "needs-input"),
    "edited column",
  );
  edited.label = label;
  edited.description = description;
  expect(page.request).toHaveBeenCalledWith("workboard.sessionsBoard.update", {
    boardId: board.id,
    patch: { columns },
  });
});
