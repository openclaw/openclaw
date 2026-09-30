import "../../test/dom.setup.ts";
import { expectDefined } from "@openclaw/normalization-core";
import type {
  WorkboardSessionsBoard,
  WorkboardSessionsBoardRead,
} from "@openclaw/workboard-contract";
import type { ControlUiAgentPickerProps } from "openclaw/plugin-sdk/control-ui";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mountPage } from "./workboard-page.test-support.ts";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function sessionsPage() {
  const board: WorkboardSessionsBoard = {
    id: "sessions",
    name: "Team sessions",
    kind: "sessions",
    createdAt: 1,
    updatedAt: 1,
    sessions: {
      columns: [
        {
          id: "working",
          label: "Working",
          description: "Active work",
          color: "blue",
          match: { run: ["active"] },
        },
        { id: "done", label: "Done", description: "Completed work", fallback: true },
      ],
    },
  };
  const result: WorkboardSessionsBoardRead = {
    board,
    columns: board.sessions.columns,
    sessions: [
      {
        key: "agent:main:working",
        sessionId: "working-id",
        agentId: "main",
        label: "Fix retries",
        run: "active",
        observerDigest: { health: "on-track", headline: "Checking reconnects", revision: 2 },
        pullRequests: [{ number: 42, state: "open" }],
        archived: false,
        lastActivityAt: Date.now() - 120_000,
        columnId: "working",
        source: "state",
        reason: "Active run",
      },
      {
        key: "agent:writer:done",
        sessionId: "done-id",
        agentId: "writer",
        derivedTitle: "Write release guide",
        run: "idle",
        pullRequests: [{ number: 43, state: "merged" }],
        archived: false,
        lastActivityAt: Date.now() - 60_000,
        columnId: "done",
        source: "operator",
        reason: "Reviewed",
      },
    ],
    warning: "Utility model temporarily unavailable",
  };
  const page = mountPage({ boardId: board.id });
  const request = expectDefined(page.request.getMockImplementation(), "request");
  page.request.mockImplementation(async (method, params) => {
    if (method === "workboard.cards.list") {
      return { cards: [], boards: [{ ...board, total: 0, active: 0, archived: 0, byStatus: {} }] };
    }
    if (method === "workboard.sessionsBoard.read") {
      return structuredClone(result);
    }
    return request(method, params);
  });
  return {
    ...page,
    board,
    result,
    async connect() {
      page.fixture.connection.connected = true;
      page.fixture.notify();
      await vi.advanceTimersByTimeAsync(0);
    },
    reads() {
      return page.request.mock.calls.filter(([method]) => method === "workboard.sessionsBoard.read")
        .length;
    },
  };
}

function button(page: ReturnType<typeof mountPage>, label: string) {
  return expectDefined(
    [...page.container.querySelectorAll<HTMLButtonElement>("button")].find(
      (entry) => (entry.getAttribute("aria-label") ?? entry.textContent?.trim()) === label,
    ),
    label,
  );
}

it("renders session columns, owner avatars and canonical facts without card controls or an unavailable dock", async () => {
  const page = sessionsPage();
  await page.connect();
  expect(
    [...page.container.querySelectorAll("[data-session-column]")].map((column) =>
      column.getAttribute("aria-label"),
    ),
  ).toEqual(["Working, 1", "Done, 1"]);
  expect(page.container.textContent).toContain("Fix retries");
  expect(page.container.textContent).toContain("Checking reconnects");
  expect(page.container.textContent).toContain("#42 · Open");
  expect(page.container.textContent).toContain("#43 · Merged");
  expect(page.container.textContent).toContain("2m ago");
  expect(
    page.container.querySelector('[data-session-key="agent:writer:done"]')?.getAttribute("title"),
  ).toContain("pinned");
  expect(page.container.querySelector('[role="status"]')?.textContent).toContain(
    "Utility model temporarily unavailable",
  );
  expect(page.fixture.host.components.mountAgentAvatar).toHaveBeenCalledWith(
    expect.any(HTMLElement),
    { agentId: "writer", label: "writer" },
  );
  expect(
    page.container.querySelector(
      ".workboard-create, .workboard-dispatch, .workboard-card, .workboard-status-tabs, .workboard-board-agent",
    ),
  ).toBeNull();
  expectDefined(
    page.container.querySelector<HTMLButtonElement>('[data-session-key="agent:main:working"]'),
    "session tile",
  ).click();
  expect(page.fixture.host.sessions.open).toHaveBeenCalledWith({
    sessionKey: "agent:main:working",
    agentId: "main",
  });
  const picker = expectDefined(
    page.container.querySelector<HTMLElement & ControlUiAgentPickerProps>(
      ".workboard-agent-filter [data-test-agent-picker]",
    ),
    "agent filter",
  );
  picker.onSelect("writer");
  await vi.advanceTimersByTimeAsync(0);
  expect(page.container.querySelectorAll(".workboard-session-tile")).toHaveLength(1);
  expect(page.container.textContent).not.toContain("Fix retries");
});

it("moves a dragged session through the placement RPC and refreshes through the board classifier", async () => {
  const page = sessionsPage();
  await page.connect();
  const tile = expectDefined(page.container.querySelector("[data-session-key]"), "session tile");
  tile.dispatchEvent(new Event("dragstart", { bubbles: true }));
  await vi.advanceTimersByTimeAsync(0);
  expectDefined(
    page.container.querySelector('[data-session-column="done"]'),
    "destination",
  ).dispatchEvent(new Event("drop", { bubbles: true, cancelable: true }));
  await vi.advanceTimersByTimeAsync(0);
  expect(page.request).toHaveBeenCalledWith("workboard.sessionsBoard.move", {
    boardId: "sessions",
    sessionKey: "agent:main:working",
    columnId: "done",
  });
  button(page, "Refresh").click();
  await vi.advanceTimersByTimeAsync(0);
  expect(page.request).toHaveBeenCalledWith("workboard.sessionsBoard.refresh", {
    boardId: "sessions",
  });
  expect(page.request.mock.calls.some(([method]) => method === "workboard.cards.move")).toBe(false);
});

it("coalesces observer events for visible sessions and rereads canonical placements on board changes", async () => {
  const page = sessionsPage();
  await page.connect();
  page.fixture.emit("session.observer", { sessionKey: "agent:other:unseen" });
  await vi.advanceTimersByTimeAsync(1000);
  expect(page.reads()).toBe(1);
  page.result.sessions[0]!.observerDigest!.headline = "New canonical headline";
  for (let revision = 1; revision <= 3; revision += 1) {
    page.fixture.emit("session.observer", { sessionKey: "agent:main:working", revision });
  }
  await vi.advanceTimersByTimeAsync(999);
  expect(page.reads()).toBe(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(page.reads()).toBe(2);
  expect(page.container.textContent).toContain("New canonical headline");
  page.fixture.emit("plugin.workboard.changed", { epoch: "current", revision: 1 });
  await vi.advanceTimersByTimeAsync(0);
  expect(page.reads()).toBe(3);
});

it("discards a sessions read completed after navigating to a card board", async () => {
  const page = sessionsPage();
  const pending = createDeferred<WorkboardSessionsBoardRead>();
  const request = expectDefined(page.request.getMockImplementation(), "request");
  page.request.mockImplementation((method, params) =>
    method === "workboard.sessionsBoard.read" ? pending.promise : request(method, params),
  );
  await page.connect();
  page.navigate("default");
  await vi.advanceTimersByTimeAsync(0);
  pending.resolve(page.result);
  await vi.advanceTimersByTimeAsync(0);
  expect(page.container.querySelector(".workboard-sessions")).toBeNull();
  expect(page.container.textContent).not.toContain("Fix retries");
  expect(page.container.querySelector(".workboard-create")).not.toBeNull();
});

it("creates a sessions board from the default Cards kind without submitting client-owned default columns", async () => {
  const page = sessionsPage();
  await page.connect();
  button(page, "New board").click();
  await vi.advanceTimersByTimeAsync(0);
  const form = expectDefined(
    page.container.querySelector<HTMLFormElement>(".workboard-board-draft"),
    "new board",
  );
  expect(form.querySelector<HTMLInputElement>('input[value="cards"]')?.checked).toBe(true);
  const name = expectDefined(
    form.querySelector<HTMLInputElement>(".workboard-board-draft__name input"),
    "board name",
  );
  name.value = "My sessions";
  name.dispatchEvent(new Event("input", { bubbles: true }));
  expectDefined(
    form.querySelector<HTMLInputElement>('input[value="sessions"]'),
    "Sessions kind",
  ).click();
  form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  await vi.advanceTimersByTimeAsync(0);
  expect(page.request).toHaveBeenCalledWith("workboard.boards.upsert", {
    id: expect.stringMatching(/^board-/),
    name: "My sessions",
    kind: "sessions",
  });
  expect(
    page.request.mock.calls.some(([method]) => method === "workboard.sessionsBoard.update"),
  ).toBe(false);
});

it("validates session columns inline and preserves their ids and rules when labels change", async () => {
  const page = sessionsPage();
  await page.connect();
  button(page, "Edit board").click();
  await vi.advanceTimersByTimeAsync(0);
  const form = expectDefined(
    page.container.querySelector<HTMLFormElement>(".workboard-board-draft"),
    "board editor",
  );
  const label = expectDefined(
    form.querySelector<HTMLInputElement>('[data-column-id="working"] input'),
    "column label",
  );
  label.value = "";
  label.dispatchEvent(new Event("input", { bubbles: true }));
  form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  await vi.advanceTimersByTimeAsync(0);
  expect(form.querySelector('[role="alert"]')?.textContent).toContain("label");
  expect(page.request.mock.calls.some(([method]) => method === "workboard.boards.upsert")).toBe(
    false,
  );
  label.value = "Building";
  label.dispatchEvent(new Event("input", { bubbles: true }));
  const instructions = expectDefined(
    form.querySelector<HTMLTextAreaElement>('textarea[aria-label="Classification instructions"]'),
    "instructions",
  );
  instructions.value = "Keep docs in review until checked";
  instructions.dispatchEvent(new Event("input", { bubbles: true }));
  form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  await vi.advanceTimersByTimeAsync(0);
  expect(page.request).toHaveBeenCalledWith("workboard.sessionsBoard.update", {
    boardId: "sessions",
    patch: {
      columns: [
        { ...page.board.sessions.columns[0], label: "Building" },
        page.board.sessions.columns[1],
      ],
      instructions: "Keep docs in review until checked",
    },
  });
});

it("creates and saves one board conversation before opening the optional dock, reusing it after a failed save", async () => {
  const page = sessionsPage();
  const openSession = vi.fn();
  Object.assign(page.fixture.host, { dock: { openSession, close: vi.fn(), openSessionKey: null } });
  vi.mocked(page.fixture.host.sessions.create).mockResolvedValue("agent:main:board-conversation");
  const request = expectDefined(page.request.getMockImplementation(), "request");
  let rejectSave = true;
  page.request.mockImplementation(async (method, params) => {
    if (method === "workboard.sessionsBoard.update") {
      if (rejectSave) {
        throw new Error("Save unavailable");
      }
      page.board.sessions.agentSessionKey = "agent:main:board-conversation";
      return { board: page.board };
    }
    return request(method, params);
  });
  await page.connect();
  button(page, "Board agent").click();
  await vi.advanceTimersByTimeAsync(0);
  expect(page.container.textContent).toContain("Save unavailable");
  expect(openSession).not.toHaveBeenCalled();
  rejectSave = false;
  button(page, "Board agent").click();
  await vi.advanceTimersByTimeAsync(0);
  expect(page.fixture.host.sessions.create).toHaveBeenCalledExactlyOnceWith({
    agentId: "main",
    label: "Sessions board · Team sessions",
  });
  expect(page.request).toHaveBeenCalledWith("workboard.sessionsBoard.update", {
    boardId: "sessions",
    patch: { agentSessionKey: "agent:main:board-conversation" },
  });
  expect(openSession).toHaveBeenCalledExactlyOnceWith({
    sessionKey: "agent:main:board-conversation",
    agentId: "main",
    label: "Sessions board · Team sessions",
    context: { page: "workboard", detail: { boardId: "sessions" } },
  });
});
