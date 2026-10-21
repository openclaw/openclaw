import "./test/dom.setup.ts";
import { expectDefined } from "@openclaw/normalization-core";
import { createDeferred } from "openclaw/plugin-sdk/concurrency-runtime";
import type {
  ControlUiAccessory,
  ControlUiNavigationItem,
  ControlUiPage,
} from "openclaw/plugin-sdk/control-ui";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import workboardPlugin from "./index.ts";
import { createGatewaySession, createWorkboardCard } from "./lib/workboard/test/index-helpers.ts";
import type { WorkboardBoardSummary } from "./lib/workboard/types.ts";
import { workboardTestHost } from "./test/host.setup.ts";
import { createViewContext } from "./test/host.ts";

let fixture: ReturnType<typeof workboardTestHost>;
let stopPlugin: (() => void) | undefined;
let stopView: (() => void) | undefined;
let request: ReturnType<typeof vi.fn<(method: string, params: unknown) => Promise<unknown>>>;
beforeEach(() => {
  vi.useFakeTimers();
  fixture = workboardTestHost();
  fixture.connection.connected = true;
  request = vi.fn();
  fixture.host.request = request as typeof fixture.host.request;
});
afterEach(() => {
  dispose();
  vi.useRealTimers();
});

function dispose() {
  stopView?.();
  stopView = undefined;
  stopPlugin?.();
  stopPlugin = undefined;
}
async function activate() {
  stopPlugin = (await workboardPlugin.activate(fixture.host)) ?? undefined;
}
const tick = () => vi.advanceTimersByTimeAsync(0);
async function change(payload: unknown = {}) {
  fixture.emit("plugin.workboard.changed", payload);
  await tick();
}
const clickDialog = (confirm: boolean) =>
  expectDefined(
    document.querySelector<HTMLButtonElement>(
      `[data-test-dialog] ${confirm ? ".danger" : "button:not(.danger)"}`,
    ),
    "dialog button",
  ).click();
async function mountPage(props: Record<string, string>) {
  const { host, registrations } = fixture;
  const container = document.createElement("div");
  document.body.append(container);
  const page = registrations.get("page/workboard") as ControlUiPage;
  const mounted = page.mount(container, createViewContext(host, props));
  stopView = () => mounted?.dispose?.();
  const update = (next: Record<string, string>, presented = true) =>
    mounted?.update?.(createViewContext(host, next, presented));
  await vi.dynamicImportSettled();
  update(props);
  await tick();
  return { container, update };
}
function mountAccessory(session: ReturnType<typeof createGatewaySession>) {
  const { host, registrations } = fixture;
  const container = document.createElement("div");
  const accessory = registrations.get("accessory/linked-card") as ControlUiAccessory;
  const mounted = accessory.mount(
    container,
    createViewContext(host, { sessionKey: session.key, session }),
  );
  stopView = () => mounted?.dispose?.();
  return container;
}

const makeBoard = (id: string, extra: Partial<WorkboardBoardSummary> = {}) => ({ id, ...extra });
function navigationItem(id: string, label: string, icon?: string) {
  return {
    id: `board-${id}`,
    parent: "workboard",
    label,
    defaultVisible: false,
    page: { id: "workboard", path: [id] },
    ...(icon ? { icon } : {}),
  };
}
const columns: NonNullable<WorkboardBoardSummary["sessions"]>["columns"] = [
  { id: "working", label: "Working", description: "Active work", match: { run: ["active"] } },
  { id: "done", label: "Done", description: "Completed work", fallback: true },
];
const sessionsBoard = (name: string) =>
  makeBoard("sessions", { name, kind: "sessions", sessions: { columns } });

it("keeps reassigned session cards current through events without polling", async () => {
  const { host, registrations } = fixture;
  const session = createGatewaySession({ key: "agent:writer:dashboard:captured" });
  const expectedCalls = [
    ["workboard.boards.list", {}],
    ["workboard.cards.list", { sessionKey: session.key }],
  ];
  const card = createWorkboardCard({
    title: "Previously captured conversation",
    sessionKey: session.key,
    agentId: "main",
    metadata: { automation: { boardId: "ops" } },
  });
  Object.assign(host.sessions, { rows: [session], selectedKey: session.key });
  Object.assign(host.agents, {
    rows: [{ id: "main" }, { id: "writer" }],
    selectedId: "writer",
    scopeId: "writer",
  });
  const boards = [makeBoard("ops", { total: 1, active: 1, byStatus: { todo: 1 } })];
  const historical = createWorkboardCard({ id: "history", notes: "history".repeat(10_000) });
  let currentCard = card;
  let responseBytes = 0;
  request.mockImplementation(async (method: string, params: unknown) => {
    if (method === "workboard.cards.list") {
      const result = {
        cards:
          params && typeof params === "object" && "sessionKey" in params
            ? [currentCard]
            : [currentCard, historical],
        boards,
      };
      responseBytes += JSON.stringify(result).length;
      return result;
    }
    if (method === "workboard.boards.list") {
      return { boards };
    }
    return { tasks: [] };
  });
  await activate();
  await vi.advanceTimersByTimeAsync(0);
  expect(registrations.has("navigation/board-ops")).toBe(true);
  expect([...registrations.keys()].filter((key) => key.startsWith("action/"))).toEqual([]);
  const container = mountAccessory(session);
  await vi.advanceTimersByTimeAsync(0);
  expect(container.textContent).toContain(card.title);
  await vi.advanceTimersByTimeAsync(15 * 60_000);
  expect(request.mock.calls).toEqual(expectedCalls);
  expect(responseBytes).toBeLessThan(2048);

  currentCard = {
    ...card,
    title: "Current captured conversation",
    updatedAt: card.updatedAt + 1,
  };
  request.mockClear();
  await change({ epoch: "catalog-epoch", revision: 1 });
  expect(container.textContent).toContain(currentCard.title);
  expect(request).toHaveBeenCalledTimes(2);
  expect(request.mock.calls).toEqual(expect.arrayContaining(expectedCalls));
  expect(responseBytes).toBeLessThan(2048);
});

it("keeps catalog navigation ordered and disambiguates names only while boards share them", async () => {
  const { host, connection, registrations } = fixture;
  const operations = makeBoard("ops", { name: "Zebra", icon: "rocket", color: "blue" });
  const sessions = sessionsBoard("Alpha");
  let boards = [operations, sessions];
  request.mockImplementation(async () => ({ cards: [], boards }));
  const register = vi.spyOn(host.ui, "registerNavigation");
  await activate();
  const boardNavigation = () =>
    [...registrations.entries()]
      .filter(([key]) => key.startsWith("navigation/board-"))
      .map(([, item]) => item as ControlUiNavigationItem)
      .toSorted((left, right) => (left.order ?? 0) - (right.order ?? 0));
  async function showBoards(next: typeof boards, labels: string[]) {
    boards = next;
    await change();
    expect(boardNavigation().map(({ label }) => label)).toEqual(labels);
  }
  await vi.advanceTimersByTimeAsync(0);
  expect(boardNavigation()).toMatchObject([
    navigationItem("ops", "Zebra", "rocket"),
    navigationItem("sessions", "Alpha"),
  ]);
  for (const item of boardNavigation()) {
    expect(item.actions).toMatchObject([
      { id: "pin", label: "Pin to sidebar" },
      { id: "delete", label: "Delete board…", destructive: true },
    ]);
  }
  const operationsNavigation = expectDefined(boardNavigation()[0], "Operations navigation");
  await expectDefined(operationsNavigation.actions?.[0], "pin action").run();
  expect(host.ui.pinNavigation).toHaveBeenCalledExactlyOnceWith("board-ops");
  vi.mocked(host.ui.pinNavigation).mockClear();
  vi.mocked(host.ui.isNavigationPinned).mockReturnValue(true);
  const unpin = expectDefined(operationsNavigation.actions?.[0], "unpin action");
  expect(unpin.label).toBe("Unpin from sidebar");
  await unpin.run();
  expect(host.ui.unpinNavigation).toHaveBeenCalledExactlyOnceWith("board-ops");
  connection.canWrite = false;
  expect(operationsNavigation.actions?.map(({ id }) => id)).toEqual(["pin"]);
  connection.canWrite = true;
  register.mockClear();
  await change();
  expect(register).not.toHaveBeenCalled();

  const ambiguous = ["Alpha (sessions)", "Alpha (cards)"];
  await showBoards(
    [sessions, { ...operations, name: "Alpha", icon: "kanban", color: "green" }],
    ambiguous,
  );
  expect(boardNavigation().map(({ id }) => id)).toEqual(["board-sessions", "board-ops"]);
  expect(registrations.get("navigation/board-ops")).toMatchObject({
    icon: "kanban",
  });

  await showBoards([sessions, { ...operations, name: "Operations" }], ["Alpha", "Operations"]);
  await showBoards([sessions, { ...operations, name: "Alpha" }], ambiguous);
  await showBoards([sessions], ["Alpha"]);
  expect(boardNavigation().map(({ id }) => id)).toEqual(["board-sessions"]);
  expect(host.ui.pinNavigation).not.toHaveBeenCalled();
  dispose();
  expect([...registrations.keys()].filter((key) => key.startsWith("navigation/"))).toEqual([]);
});

it.each(["open", "another board", "hidden"] as const)(
  "deletes a board after confirmation without leaving a %s page incorrectly",
  async (presentation) => {
    const { host, registrations } = fixture;
    let boards = [makeBoard("ops", { name: "Operations" }), makeBoard("other")];
    const deleted = createDeferred<{ deleted: boolean }>();
    const stale = createDeferred<{ cards: never[]; boards: typeof boards }>();
    let pendingCatalog: typeof stale.promise | undefined;
    request.mockImplementation(async (method: string) => {
      if (method === "workboard.boards.delete") {
        return deleted.promise;
      }
      if (method === "workboard.boards.list" && pendingCatalog) {
        const pending = pendingCatalog;
        pendingCatalog = undefined;
        return pending;
      }
      return { cards: [], boards };
    });
    await activate();
    await vi.advanceTimersByTimeAsync(0);
    const { update } = await mountPage({ boardId: "ops" });
    const previousBoards = boards;
    if (presentation === "open") {
      pendingCatalog = stale.promise;
      await change();
    }
    const item = registrations.get("navigation/board-ops") as ControlUiNavigationItem;
    const pending = item.actions?.find(({ id }) => id === "delete")?.run();
    const dialog = expectDefined(
      document.querySelector<HTMLElement>("[data-test-dialog]"),
      "dialog",
    );
    expect(dialog.getAttribute("aria-label")).toBe("Delete “Operations”?");
    expect(request.mock.calls.some(([method]) => method === "workboard.boards.delete")).toBe(false);
    clickDialog(true);
    expect(request).toHaveBeenCalledWith("workboard.boards.delete", { id: "ops" });
    expect(host.ui.unpinNavigation).not.toHaveBeenCalled();
    if (presentation !== "open") {
      update(
        { boardId: presentation === "another board" ? "other" : "ops" },
        presentation !== "hidden",
      );
    }
    boards = boards.filter(({ id }) => id !== "ops");
    deleted.resolve({ deleted: true });
    await pending;
    await vi.advanceTimersByTimeAsync(0);
    stale.resolve({ cards: [], boards: previousBoards });
    await vi.advanceTimersByTimeAsync(0);
    expect(host.ui.unpinNavigation).toHaveBeenCalledExactlyOnceWith("board-ops");
    expect(registrations.has("navigation/board-ops")).toBe(false);
    expect(document.querySelector("[data-test-dialog]")).toBeNull();
    if (presentation === "open") {
      expect(host.navigation.openPage).toHaveBeenCalledExactlyOnceWith(
        { id: "workboard", path: [] },
        { replace: true, preserveSearch: true },
      );
    } else {
      expect(host.navigation.openPage).not.toHaveBeenCalled();
    }
  },
);

it("keeps a board and its pin when deletion is canceled, refused, or fails", async () => {
  const { host, connection, registrations } = fixture;
  const operations = makeBoard("ops", { name: "Operations" });
  request.mockImplementation(async (method: string) => {
    if (method === "workboard.boards.delete") {
      throw new Error("board still has cards; archive it or move/delete the cards first.");
    }
    return { cards: [], boards: [operations] };
  });
  await activate();
  await vi.advanceTimersByTimeAsync(0);
  const item = registrations.get("navigation/board-ops") as ControlUiNavigationItem;
  const action = expectDefined(
    item.actions?.find(({ id }) => id === "delete"),
    "delete action",
  );
  const cancel = action.run();
  clickDialog(false);
  await cancel;
  const pending = action.run();
  connection.canWrite = false;
  clickDialog(true);
  await vi.advanceTimersByTimeAsync(0);
  expect(document.querySelector("[role=alert]")?.textContent).toContain(
    "Connect with write access",
  );
  expect(request.mock.calls.some(([method]) => method === "workboard.boards.delete")).toBe(false);
  connection.canWrite = true;
  clickDialog(true);
  await vi.advanceTimersByTimeAsync(0);
  expect(document.querySelector("[role=alert]")?.textContent).toContain("board still has cards");
  expect(registrations.has("navigation/board-ops")).toBe(true);
  expect(host.ui.unpinNavigation).not.toHaveBeenCalled();
  expect(host.navigation.openPage).not.toHaveBeenCalled();
  clickDialog(false);
  await pending;
});

it("disambiguates a created board and its sibling before pinning through a stale catalog completion", async () => {
  const { host, registrations } = fixture;
  const board = { id: "created", name: "Created", icon: "rocket", createdAt: 1, updatedAt: 1 };
  const existing = sessionsBoard("Created");
  const stale = createDeferred<unknown>();
  const refreshed = createDeferred<unknown>();
  const read = vi.fn<() => Promise<unknown>>().mockResolvedValue({ cards: [], boards: [existing] });
  request.mockImplementation(async (method: string) => {
    if (method === "workboard.boards.upsert") {
      read.mockReturnValue(refreshed.promise);
      return { board };
    }
    if (method === "workboard.cards.list" || method === "workboard.boards.list") {
      return read();
    }
    return {};
  });
  let pinnedNavigation: unknown;
  let siblingAtPin: unknown;
  vi.mocked(host.ui.pinNavigation).mockImplementation((id) => {
    pinnedNavigation = registrations.get(`navigation/${id}`);
    siblingAtPin = registrations.get("navigation/board-sessions");
  });
  const register = vi.spyOn(host.ui, "registerNavigation");
  await activate();
  const { container } = await mountPage({});
  expect(registrations.get("navigation/board-sessions")).toMatchObject({ label: "Created" });
  expectDefined(
    [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.trim() === "New board",
    ),
    "new board button",
  ).click();
  await vi.advanceTimersByTimeAsync(0);
  read.mockReturnValue(stale.promise);
  fixture.emit("plugin.workboard.changed", {});
  const form = expectDefined(
    container.querySelector<HTMLFormElement>(".workboard-board-draft"),
    "board draft form",
  );
  const name = expectDefined(
    form.querySelector<HTMLInputElement>(".workboard-board-draft__name input"),
    "board name input",
  );
  name.value = board.name;
  name.dispatchEvent(new Event("input", { bubbles: true }));
  form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  await vi.advanceTimersByTimeAsync(0);
  expect(host.ui.pinNavigation).toHaveBeenCalledExactlyOnceWith("board-created");
  expect(pinnedNavigation).toMatchObject(navigationItem("created", "Created (cards)", "rocket"));
  expect(siblingAtPin).toMatchObject({ label: "Created (sessions)" });

  stale.resolve({ cards: [], boards: [existing] });
  await vi.advanceTimersByTimeAsync(0);
  expect(registrations.get("navigation/board-created")).toBe(pinnedNavigation);
  refreshed.resolve({
    cards: [],
    boards: [existing, board],
  });
  await vi.advanceTimersByTimeAsync(0);
  register.mockClear();
  await change();
  expect(register).not.toHaveBeenCalled();
  expect(host.ui.pinNavigation).toHaveBeenCalledOnce();
});

it("recovers accessory reads independently from the catalog and retires pending reads", async () => {
  const hostListeners = fixture.listeners.size;
  const { host, registrations } = fixture;
  const session = createGatewaySession();
  const card = createWorkboardCard({ title: "Linked card", sessionKey: session.key });
  const boards = [makeBoard("default")];
  let currentCard = card;
  const read = vi.fn<() => Promise<unknown>>(async () => ({ cards: [currentCard] }));
  request.mockImplementation(async (method: string) =>
    method === "workboard.boards.list" ? { boards } : read(),
  );
  await activate();
  const container = mountAccessory(session);
  await vi.advanceTimersByTimeAsync(0);
  expect(container.textContent).toContain(card.title);
  expect([...registrations.keys()].filter((key) => key.startsWith("action/"))).toEqual([]);

  read.mockRejectedValueOnce(new Error("Temporary read failure"));
  await change();
  expect(request.mock.settledResults.some((result) => result.type === "rejected")).toBe(true);
  expect(container.textContent).toContain(card.title);

  currentCard = { ...card, metadata: { archivedAt: 1 } };
  await change();
  expect(container.querySelector("a")).toBeNull();

  currentCard = card;
  await change();
  expect(container.textContent).toContain(card.title);

  const pending = createDeferred<unknown>();
  read.mockReturnValueOnce(pending.promise);
  await change();
  const count = request.mock.calls.length;
  dispose();
  const invalidations = vi.mocked(host.ui.invalidate).mock.calls.length;
  pending.resolve({ cards: [{ ...card, title: "Retired response" }] });
  await vi.advanceTimersByTimeAsync(0);
  fixture.emit("plugin.workboard.changed", {});
  fixture.notify();
  expect(request).toHaveBeenCalledTimes(count);
  expect(vi.mocked(host.ui.invalidate).mock.calls.length).toBe(invalidations);
  expect(container.childElementCount).toBe(0);
  expect(fixture.events.get("plugin.workboard.changed")?.size).toBe(0);
  expect(fixture.listeners.size).toBe(hostListeners);
});
