import "../../test/dom.setup.ts";
import { expectDefined } from "@openclaw/normalization-core";
import {
  createDefaultWorkboardSessionsBoardSpec,
  patchWorkboardSessionsBoardSpec,
  type WorkboardSessionsBoardSpec,
} from "@openclaw/workboard-contract";
import type { ControlUiHost, ControlUiSession } from "openclaw/plugin-sdk/control-ui";
import { expect, it, onTestFinished, vi } from "vitest";
import { requireButton } from "./view.test-support.ts";
import { mountPage, openBoardEditor } from "./workboard-page.test-support.ts";

type Picker = HTMLElement & Parameters<ControlUiHost["components"]["mountSelectPicker"]>[1];

const roster = [
  { key: "agent:main:retry", label: "Fix retries", kind: "direct", updatedAt: 1 },
  { key: "agent:main:docs", displayName: "Write docs", kind: "direct", updatedAt: 1 },
] satisfies ControlUiSession[];

async function mountSessionsPage(scope?: WorkboardSessionsBoardSpec["scope"]) {
  vi.useFakeTimers();
  onTestFinished(() => {
    vi.useRealTimers();
  });
  const sessions = createDefaultWorkboardSessionsBoardSpec();
  if (scope) {
    sessions.scope = scope;
  }
  const board = { id: "garden", kind: "sessions", name: "Garden", sessions };
  const page = mountPage({ boardId: board.id });
  Object.assign(page.fixture.host.sessions, { rows: roster });
  const request = expectDefined(page.request.getMockImplementation(), "request");
  page.request.mockImplementation(async (method, params) => {
    if (method === "workboard.cards.list") {
      return { cards: [], boards: [{ ...board, total: 0, active: 0, archived: 0, byStatus: {} }] };
    }
    if (method === "workboard.sessionsBoard.read") {
      return { board, columns: board.sessions.columns, sessions: [], total: 0, people: [] };
    }
    if (method === "gateway.identity.get") {
      return { deviceId: "gateway-one" };
    }
    if (method === "users.self") {
      return { profile: { id: "viewer" } };
    }
    if (method === "sessions.groups.list") {
      return { groups: [{ name: "Design", position: 0 }] };
    }
    if (method === "projects.list") {
      return { projects: [{ id: "openclaw", displayName: "OpenClaw", source: "registered" }] };
    }
    if (method === "workboard.sessionsBoard.update") {
      if (!params || typeof params !== "object" || !("patch" in params)) {
        throw new Error("Missing Sessions board patch");
      }
      board.sessions = patchWorkboardSessionsBoardSpec(board.sessions, params.patch);
      return { board };
    }
    return request(method, params);
  });
  page.fixture.connection.connected = true;
  page.fixture.notify();
  await vi.advanceTimersByTimeAsync(0);
  return { board, page };
}

function picker(form: Element, label: string) {
  return expectDefined(
    [...form.querySelectorAll<Picker>("[data-test-select-picker]")].find(
      (entry) => entry.accessibleLabel === label,
    ),
    `${label} picker`,
  );
}

function radio(form: Element, label: string) {
  return expectDefined(
    [...form.querySelectorAll<HTMLLabelElement>(".workboard-sessions-scope__modes label")]
      .find((entry) => entry.textContent?.trim() === label)
      ?.querySelector<HTMLInputElement>("input"),
    `${label} radio`,
  );
}

function updates(page: ReturnType<typeof mountPage>) {
  return page.request.mock.calls.filter(([method]) => method === "workboard.sessionsBoard.update");
}

it("creates a Sessions board with the filters chosen in the same editor", async () => {
  const { page } = await mountSessionsPage();
  requireButton(page.container, "New board").click();
  await vi.advanceTimersByTimeAsync(0);
  const form = expectDefined(
    page.container.querySelector<HTMLFormElement>(".workboard-board-draft"),
    "new board form",
  );
  expect(form.querySelector(".workboard-sessions-scope")).toBeNull();
  expectDefined(
    form.querySelector<HTMLInputElement>('input[name="board-kind"][value="sessions"]'),
    "Sessions kind",
  ).click();
  await vi.advanceTimersByTimeAsync(0);
  expect(form.querySelector(".workboard-sessions-scope legend")?.textContent).toBe(
    "Sessions to show",
  );

  const name = expectDefined(
    form.querySelector<HTMLInputElement>(".workboard-board-draft__name input"),
    "name",
  );
  name.value = "Retry work";
  name.dispatchEvent(new Event("input", { bubbles: true }));
  expect(picker(form, "Group").options.map((option) => option.label)).toEqual([
    "Any group",
    "No group",
    "Design",
  ]);
  picker(form, "Group").onSelect("group:Design");
  picker(form, "Project").onSelect("openclaw");
  const title = expectDefined(
    form.querySelector<HTMLInputElement>(".workboard-sessions-scope__filters input"),
    "title filter",
  );
  title.value = "  retry ";
  title.dispatchEvent(new Event("input", { bubbles: true }));
  radio(form, "Only selected sessions").click();
  await vi.advanceTimersByTimeAsync(0);
  expect(form.querySelector('.workboard-sessions-scope [role="status"]')?.textContent).toBe(
    "No sessions selected. The board stays empty until you add one.",
  );
  picker(form, "Add session").onSelect("agent:main:retry");
  await vi.advanceTimersByTimeAsync(0);
  expect(
    [...form.querySelectorAll(".workboard-sessions-scope__chip > span")].map(
      (chip) => chip.textContent,
    ),
  ).toEqual(["Fix retries"]);
  expect(picker(form, "Add session").options.map((option) => option.value)).toEqual([
    "",
    "agent:main:docs",
  ]);

  form.requestSubmit();
  await vi.advanceTimersByTimeAsync(0);
  const upsert = expectDefined(
    page.request.mock.calls.find(([method]) => method === "workboard.boards.upsert"),
    "upsert",
  )[1];
  expect(upsert).toEqual({
    id: expect.stringMatching(/^board-/),
    kind: "sessions",
    name: "Retry work",
    scope: {
      group: "Design",
      projectId: "openclaw",
      titleContains: "retry",
      includeSessionKeys: ["agent:main:retry"],
    },
  });
  expect(updates(page)).toHaveLength(0);
});

it("creates an unrestricted Sessions board without a scope", async () => {
  const { page } = await mountSessionsPage();
  requireButton(page.container, "New board").click();
  await vi.advanceTimersByTimeAsync(0);
  const form = expectDefined(
    page.container.querySelector<HTMLFormElement>(".workboard-board-draft"),
    "new board form",
  );
  expectDefined(
    form.querySelector<HTMLInputElement>('input[name="board-kind"][value="sessions"]'),
    "Sessions kind",
  ).click();
  const name = expectDefined(
    form.querySelector<HTMLInputElement>(".workboard-board-draft__name input"),
    "name",
  );
  name.value = "Everything";
  name.dispatchEvent(new Event("input", { bubbles: true }));
  form.requestSubmit();
  await vi.advanceTimersByTimeAsync(0);
  expect(page.request).toHaveBeenCalledWith("workboard.boards.upsert", {
    id: expect.stringMatching(/^board-/),
    kind: "sessions",
    name: "Everything",
  });
});

it("saves an empty selection without replacing other filters", async () => {
  const { board, page } = await mountSessionsPage({
    agentIds: ["main"],
    maxAgeHours: 24,
    includeArchived: true,
    group: "Design",
    includeSessionKeys: ["agent:main:retry", "agent:main:docs"],
  });
  const form = await openBoardEditor(page);
  expect(picker(form, "Group").value).toBe("group:Design");
  expect(radio(form, "Only selected sessions").checked).toBe(true);
  const removeButton = (name: string) =>
    expectDefined(
      form.querySelector<HTMLButtonElement>(`button[aria-label="Remove ${name}"]`),
      `remove ${name}`,
    );
  removeButton("Fix retries").focus();
  removeButton("Fix retries").click();
  await vi.advanceTimersByTimeAsync(0);
  expect(document.activeElement).toBe(removeButton("Write docs"));
  removeButton("Write docs").click();
  await vi.advanceTimersByTimeAsync(0);
  // Removing the last pick keeps the board limited to picked sessions; it does not widen it.
  expect(form.querySelector(".workboard-sessions-scope__chip")).toBeNull();
  expect(radio(form, "Only selected sessions").checked).toBe(true);
  expect(document.activeElement).toBe(radio(form, "Only selected sessions"));
  expect(form.querySelector('.workboard-sessions-scope [role="status"]')?.textContent).toContain(
    "No sessions selected.",
  );

  form.requestSubmit();
  await vi.advanceTimersByTimeAsync(0);
  expect(updates(page)).toEqual([
    [
      "workboard.sessionsBoard.update",
      {
        boardId: board.id,
        patch: {
          scopeChanges: { includeSessionKeys: [] },
        },
      },
    ],
  ]);
});

it("clears filters back to any session without dropping other scope fields", async () => {
  const { board, page } = await mountSessionsPage({
    agentIds: ["writer"],
    group: "",
    titleContains: "retry",
    includeSessionKeys: ["agent:main:retry"],
  });
  const form = await openBoardEditor(page);
  expect(picker(form, "Group").value).toBe("none");
  picker(form, "Group").onSelect("any");
  const title = expectDefined(
    form.querySelector<HTMLInputElement>(".workboard-sessions-scope__filters input"),
    "title filter",
  );
  expect(title.value).toBe("retry");
  title.value = "";
  title.dispatchEvent(new Event("input", { bubbles: true }));
  radio(form, "All matching sessions").click();
  await vi.advanceTimersByTimeAsync(0);
  expect(form.querySelector(".workboard-sessions-scope__picked")).toBeNull();
  // Switching back within the same edit restores the parked picks.
  radio(form, "Only selected sessions").click();
  await vi.advanceTimersByTimeAsync(0);
  expect(
    [...form.querySelectorAll(".workboard-sessions-scope__chip > span")].map(
      (chip) => chip.textContent,
    ),
  ).toEqual(["Fix retries"]);
  radio(form, "All matching sessions").click();
  form.requestSubmit();
  await vi.advanceTimersByTimeAsync(0);
  expect(page.request).toHaveBeenCalledWith("workboard.sessionsBoard.update", {
    boardId: board.id,
    patch: { scopeChanges: { group: null, titleContains: null, includeSessionKeys: null } },
  });
});

it("preserves the Board agent’s newer filters when saving an open draft", async () => {
  const { board, page } = await mountSessionsPage({
    agentIds: ["main", "writer"],
    includeSessionKeys: [],
  });
  const form = await openBoardEditor(page);
  const title = expectDefined(
    form.querySelector<HTMLInputElement>(".workboard-sessions-scope__filters input"),
    "title filter",
  );
  title.value = "retry";
  title.dispatchEvent(new Event("input", { bubbles: true }));
  const newer = { agentIds: ["writer"], includeSessionKeys: ["agent:main:docs"] };
  await page.request("workboard.sessionsBoard.update", {
    boardId: board.id,
    patch: { scope: newer },
  });
  form.requestSubmit();
  await vi.advanceTimersByTimeAsync(0);
  expect(board.sessions.scope).toEqual({ ...newer, titleContains: "retry" });
});

it("recovers both choice lists on reconnect without losing the open draft", async () => {
  const { page } = await mountSessionsPage();
  const request = expectDefined(page.request.getMockImplementation(), "request");
  let unavailable = true;
  page.request.mockImplementation((method, params) => {
    if (unavailable && (method === "projects.list" || method === "sessions.groups.list")) {
      return Promise.reject(new Error("Disconnected"));
    }
    return request(method, params);
  });
  const form = await openBoardEditor(page);
  await vi.advanceTimersByTimeAsync(0);
  expect(picker(form, "Project").options).toHaveLength(1);
  radio(form, "Only selected sessions").click();
  page.fixture.connection.connected = false;
  page.fixture.notify();
  await vi.advanceTimersByTimeAsync(0);
  unavailable = false;
  page.fixture.connection.connected = true;
  page.fixture.notify();
  await vi.advanceTimersByTimeAsync(0);
  expect(page.container.querySelector(".workboard-board-draft")).toBe(form);
  expect(radio(form, "Only selected sessions").checked).toBe(true);
  expect(picker(form, "Project").options.map((option) => option.label)).toContain("OpenClaw");
  expect(picker(form, "Group").options.map((option) => option.label)).toContain("Design");
});

it("cancels scope edits without saving or changing the open board", async () => {
  const { board, page } = await mountSessionsPage({ group: "Design" });
  let form = await openBoardEditor(page);
  picker(form, "Group").onSelect("any");
  picker(form, "Project").onSelect("openclaw");
  requireButton(form, "Cancel").click();
  await vi.advanceTimersByTimeAsync(0);
  expect(page.container.querySelector(".workboard-board-draft")).toBeNull();
  expect(updates(page)).toHaveLength(0);
  expect(board.sessions.scope).toEqual({ group: "Design" });

  form = await openBoardEditor(page);
  expect(picker(form, "Group").value).toBe("group:Design");
  expect(picker(form, "Project").value).toBe("");
  // A rename alone leaves the saved scope untouched.
  const name = expectDefined(
    form.querySelector<HTMLInputElement>(".workboard-board-draft__name input"),
    "name",
  );
  name.value = "Garden review";
  name.dispatchEvent(new Event("input", { bubbles: true }));
  form.requestSubmit();
  await vi.advanceTimersByTimeAsync(0);
  expect(updates(page)).toHaveLength(0);
});

it.each([
  {
    name: "picked",
    scope: { includeSessionKeys: [] },
    summary: "No sessions selected",
    message: "No sessions selected for this board.",
    action: "Select sessions",
  },
  {
    name: "filtered",
    scope: { group: "Design", projectId: "openclaw", titleContains: "retry" },
    // The saved project id reads as the project's name.
    summary: "Design · OpenClaw · “retry”",
    message: "No sessions match this board’s filters.",
    action: "Edit filters",
  },
])("explains an empty $name board and opens the same editor", async (example) => {
  const { page } = await mountSessionsPage(example.scope);
  await vi.advanceTimersByTimeAsync(0);
  const heading = expectDefined(
    page.container.querySelector<HTMLButtonElement>(".workboard-heading__scope-name"),
    "scope heading",
  );
  expect(heading.textContent).toBe(example.summary);
  expect(heading.getAttribute("aria-label")).toBe(`Board filters: ${example.summary}`);
  const empty = expectDefined(
    page.container.querySelector(".workboard-sessions__scope-empty"),
    "scoped empty state",
  );
  expect(empty.getAttribute("role")).toBe("status");
  expect(empty.textContent).toContain(example.message);
  // One board-level explanation replaces the per-column empty lines.
  expect(page.container.querySelectorAll(".workboard-sessions__empty")).toHaveLength(0);
  requireButton(empty as HTMLElement, example.action).click();
  await vi.advanceTimersByTimeAsync(0);
  expect(page.container.querySelector(".workboard-sessions-scope")).not.toBeNull();
});

it("keeps the per-column empty lines for an unrestricted board", async () => {
  const { page } = await mountSessionsPage();
  await vi.advanceTimersByTimeAsync(0);
  expect(page.container.querySelector(".workboard-heading__scope")).toBeNull();
  expect(page.container.querySelector(".workboard-sessions__scope-empty")).toBeNull();
  expect(page.container.querySelectorAll(".workboard-sessions__empty").length).toBeGreaterThan(0);
});
