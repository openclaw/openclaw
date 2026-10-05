import "./test/dom.setup.ts";
import { expectDefined } from "@openclaw/normalization-core";
import type {
  ControlUiAccessory,
  ControlUiNavigationItem,
  ControlUiPage,
} from "openclaw/plugin-sdk/control-ui";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, expect, it, vi } from "vitest";
import workboardPlugin from "./index.ts";
import { createGatewaySession, createWorkboardCard } from "./lib/workboard/test/index-helpers.ts";
import { workboardTestHost } from "./test/host.setup.ts";
import { createViewContext } from "./test/host.ts";

afterEach(() => {
  vi.useRealTimers();
});

function sessionsBoard(name: string) {
  return {
    id: "sessions",
    name,
    kind: "sessions",
    total: 0,
    active: 0,
    archived: 0,
    byStatus: {},
    sessions: {
      columns: [
        { id: "working", label: "Working", description: "Active work", match: { run: ["active"] } },
        { id: "done", label: "Done", description: "Completed work", fallback: true },
      ],
    },
  };
}

it("keeps reassigned session cards current through events without polling", async () => {
  vi.useFakeTimers();
  const fixture = workboardTestHost();
  const { host, connection, registrations } = fixture;
  connection.connected = true;
  const session = createGatewaySession({ key: "agent:writer:dashboard:captured" });
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
  const boards = [{ id: "ops", total: 1, active: 1, archived: 0, byStatus: { todo: 1 } }];
  let currentCard = card;
  const request = vi.fn(async (method: string) => {
    if (method === "workboard.cards.list") {
      return { cards: [currentCard], boards };
    }
    if (method === "workboard.boards.list") {
      return { boards };
    }
    return { tasks: [] };
  });
  host.request = request as typeof host.request;
  const dispose = await workboardPlugin.activate(host);
  const container = document.createElement("div");
  let disposeAccessory = () => {};
  try {
    await vi.advanceTimersByTimeAsync(0);
    expect(registrations.has("navigation/board-ops")).toBe(true);
    const context = { sessionKey: session.key, session };
    expect([...registrations.keys()].filter((key) => key.startsWith("action/"))).toEqual([]);

    const accessory = registrations.get("accessory/linked-card") as ControlUiAccessory;
    const mounted = accessory.mount(container, createViewContext(host, context));
    disposeAccessory = () => mounted?.dispose?.();
    expect(container.textContent).toContain(card.title);
    await vi.advanceTimersByTimeAsync(15 * 60_000);
    expect(request.mock.calls).toEqual([["workboard.cards.list", {}]]);

    // The session accessory follows the catalog's refreshed card state.
    currentCard = {
      ...card,
      title: "Current captured conversation",
      updatedAt: card.updatedAt + 1,
    };
    request.mockClear();
    fixture.emit("plugin.workboard.changed", { epoch: "catalog-epoch", revision: 1 });
    await vi.advanceTimersByTimeAsync(0);
    expect(container.textContent).toContain(currentCard.title);
    expect(request.mock.calls).toEqual([["workboard.cards.list", {}]]);
  } finally {
    disposeAccessory();
    dispose?.();
  }
});

it("keeps catalog navigation ordered and disambiguates names only while boards share them", async () => {
  vi.useFakeTimers();
  const fixture = workboardTestHost();
  const { host, connection, registrations } = fixture;
  connection.connected = true;
  const empty = { total: 0, active: 0, archived: 0, byStatus: {} };
  const operations = { ...empty, id: "ops", name: "Zebra", icon: "rocket", color: "blue" };
  const sessions = sessionsBoard("Alpha");
  let boards = [operations, sessions];
  host.request = vi.fn(async () => ({ cards: [], boards })) as typeof host.request;
  const register = vi.spyOn(host.ui, "registerNavigation");
  const dispose = await workboardPlugin.activate(host);
  const boardNavigation = () =>
    [...registrations.entries()]
      .filter(([key]) => key.startsWith("navigation/board-"))
      .map(([, item]) => item as ControlUiNavigationItem)
      .toSorted((left, right) => (left.order ?? 0) - (right.order ?? 0));
  try {
    await vi.advanceTimersByTimeAsync(0);
    expect(boardNavigation()).toMatchObject([
      {
        id: "board-ops",
        parent: "workboard",
        label: "Zebra",
        icon: "rocket",
        defaultVisible: false,
        page: { id: "workboard", path: ["ops"] },
      },
      {
        id: "board-sessions",
        parent: "workboard",
        label: "Alpha",
        defaultVisible: false,
        page: { id: "workboard", path: ["sessions"] },
      },
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
    fixture.emit("plugin.workboard.changed", {});
    await vi.advanceTimersByTimeAsync(0);
    expect(register).not.toHaveBeenCalled();

    boards = [sessions, { ...operations, name: "Alpha", icon: "kanban", color: "green" }];
    fixture.emit("plugin.workboard.changed", {});
    await vi.advanceTimersByTimeAsync(0);
    expect(boardNavigation().map(({ id }) => id)).toEqual(["board-sessions", "board-ops"]);
    expect(boardNavigation().map(({ label }) => label)).toEqual([
      "Alpha (sessions)",
      "Alpha (cards)",
    ]);
    expect(registrations.get("navigation/board-ops")).toMatchObject({
      icon: "kanban",
    });

    boards = [sessions, { ...operations, name: "Operations" }];
    fixture.emit("plugin.workboard.changed", {});
    await vi.advanceTimersByTimeAsync(0);
    expect(boardNavigation().map(({ label }) => label)).toEqual(["Alpha", "Operations"]);

    boards = [sessions, { ...operations, name: "Alpha" }];
    fixture.emit("plugin.workboard.changed", {});
    await vi.advanceTimersByTimeAsync(0);
    expect(boardNavigation().map(({ label }) => label)).toEqual([
      "Alpha (sessions)",
      "Alpha (cards)",
    ]);
    boards = [sessions];
    fixture.emit("plugin.workboard.changed", {});
    await vi.advanceTimersByTimeAsync(0);
    expect(boardNavigation().map(({ id }) => id)).toEqual(["board-sessions"]);
    expect(boardNavigation().map(({ label }) => label)).toEqual(["Alpha"]);
    expect(host.ui.pinNavigation).not.toHaveBeenCalled();
  } finally {
    dispose?.();
  }
  expect([...registrations.keys()].filter((key) => key.startsWith("navigation/"))).toEqual([]);
});

it.each(["open", "another board", "hidden"] as const)(
  "deletes a board after confirmation without leaving a %s page incorrectly",
  async (presentation) => {
    vi.useFakeTimers();
    const fixture = workboardTestHost();
    const { host, connection, registrations } = fixture;
    connection.connected = true;
    const empty = { total: 0, active: 0, archived: 0, byStatus: {} };
    let boards = [
      { ...empty, id: "ops", name: "Operations" },
      { ...empty, id: "other" },
    ];
    const deleted = createDeferred<{ deleted: boolean }>();
    const stale = createDeferred<{ cards: never[]; boards: typeof boards }>();
    let pendingCatalog: typeof stale.promise | undefined;
    const request = vi.fn(async (method: string) => {
      if (method === "workboard.boards.delete") {
        return deleted.promise;
      }
      if (method === "workboard.cards.list" && pendingCatalog) {
        const pending = pendingCatalog;
        pendingCatalog = undefined;
        return pending;
      }
      return { cards: [], boards };
    });
    host.request = request as typeof host.request;
    const dispose = await workboardPlugin.activate(host);
    await vi.advanceTimersByTimeAsync(0);
    const page = registrations.get("page/workboard") as ControlUiPage;
    const container = document.createElement("div");
    document.body.append(container);
    const mounted = page.mount(container, createViewContext(host, { boardId: "ops" }));
    try {
      await vi.advanceTimersByTimeAsync(0);
      const previousBoards = boards;
      if (presentation === "open") {
        pendingCatalog = stale.promise;
        fixture.emit("plugin.workboard.changed", {});
        await vi.advanceTimersByTimeAsync(0);
      }
      const item = registrations.get("navigation/board-ops") as ControlUiNavigationItem;
      const pending = item.actions?.find(({ id }) => id === "delete")?.run();
      const dialog = expectDefined(
        document.querySelector<HTMLElement>("[data-test-dialog]"),
        "delete confirmation",
      );
      expect(dialog.getAttribute("aria-label")).toBe("Delete “Operations”?");
      expect(request.mock.calls.some(([method]) => method === "workboard.boards.delete")).toBe(
        false,
      );
      expectDefined(dialog.querySelector<HTMLButtonElement>(".danger"), "confirm delete").click();
      expect(request).toHaveBeenCalledWith("workboard.boards.delete", { id: "ops" });
      expect(host.ui.unpinNavigation).not.toHaveBeenCalled();
      if (presentation !== "open") {
        mounted?.update?.(
          createViewContext(
            host,
            { boardId: presentation === "another board" ? "other" : "ops" },
            presentation !== "hidden",
          ),
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
    } finally {
      mounted?.dispose?.();
      dispose?.();
    }
  },
);

it("keeps a board and its pin when deletion is canceled, refused, or fails", async () => {
  vi.useFakeTimers();
  const { host, connection, registrations } = workboardTestHost();
  connection.connected = true;
  const board = { id: "ops", name: "Operations", total: 1, active: 1, archived: 0, byStatus: {} };
  const request = vi.fn(async (method: string) => {
    if (method === "workboard.boards.delete") {
      throw new Error("board still has cards; archive it or move/delete the cards first.");
    }
    return { cards: [], boards: [board] };
  });
  host.request = request as typeof host.request;
  const dispose = await workboardPlugin.activate(host);
  try {
    await vi.advanceTimersByTimeAsync(0);
    const item = registrations.get("navigation/board-ops") as ControlUiNavigationItem;
    const action = expectDefined(
      item.actions?.find(({ id }) => id === "delete"),
      "delete action",
    );
    const cancel = action.run();
    expectDefined(
      document.querySelector<HTMLButtonElement>("[data-test-dialog] button:not(.danger)"),
      "cancel",
    ).click();
    await cancel;
    const pending = action.run();
    connection.canWrite = false;
    expectDefined(
      document.querySelector<HTMLButtonElement>("[data-test-dialog] .danger"),
      "confirm",
    ).click();
    await vi.advanceTimersByTimeAsync(0);
    expect(document.querySelector("[role=alert]")?.textContent).toContain(
      "Connect with write access",
    );
    expect(request.mock.calls.some(([method]) => method === "workboard.boards.delete")).toBe(false);
    connection.canWrite = true;
    expectDefined(
      document.querySelector<HTMLButtonElement>("[data-test-dialog] .danger"),
      "retry",
    ).click();
    await vi.advanceTimersByTimeAsync(0);
    expect(document.querySelector("[role=alert]")?.textContent).toContain("board still has cards");
    expect(registrations.has("navigation/board-ops")).toBe(true);
    expect(host.ui.unpinNavigation).not.toHaveBeenCalled();
    expect(host.navigation.openPage).not.toHaveBeenCalled();
    expectDefined(
      document.querySelector<HTMLButtonElement>("[data-test-dialog] button:not(.danger)"),
      "cancel",
    ).click();
    await pending;
  } finally {
    dispose?.();
  }
});

it("disambiguates a created board and its sibling before pinning through a stale catalog completion", async () => {
  vi.useFakeTimers();
  const fixture = workboardTestHost();
  const { host, connection, registrations } = fixture;
  connection.connected = true;
  const board = { id: "created", name: "Created", icon: "rocket", createdAt: 1, updatedAt: 1 };
  const existing = sessionsBoard("Created");
  const stale = createDeferred<unknown>();
  const refreshed = createDeferred<unknown>();
  let refreshing = false;
  let created = false;
  host.request = vi.fn(async (method: string) => {
    if (method === "workboard.boards.upsert") {
      created = true;
      return { board };
    }
    if (method === "workboard.cards.list") {
      return created
        ? refreshed.promise
        : refreshing
          ? stale.promise
          : { cards: [], boards: [existing] };
    }
    return {};
  }) as typeof host.request;
  let pinnedNavigation: unknown;
  let siblingAtPin: unknown;
  vi.mocked(host.ui.pinNavigation).mockImplementation((id) => {
    pinnedNavigation = registrations.get(`navigation/${id}`);
    siblingAtPin = registrations.get("navigation/board-sessions");
  });
  const register = vi.spyOn(host.ui, "registerNavigation");
  const dispose = await workboardPlugin.activate(host);
  const container = document.createElement("div");
  document.body.append(container);
  const page = registrations.get("page/workboard") as ControlUiPage;
  const mounted = page.mount(container, createViewContext(host, {}));
  try {
    await vi.advanceTimersByTimeAsync(0);
    expect(registrations.get("navigation/board-sessions")).toMatchObject({ label: "Created" });
    expectDefined(
      [...container.querySelectorAll<HTMLButtonElement>("button")].find(
        (button) => button.textContent?.trim() === "New board",
      ),
      "new board button",
    ).click();
    await vi.advanceTimersByTimeAsync(0);
    refreshing = true;
    fixture.emit("plugin.workboard.changed", {});
    const form = expectDefined(
      container.querySelector<HTMLFormElement>(".workboard-board-draft"),
      "new board form",
    );
    const name = expectDefined(
      form.querySelector<HTMLInputElement>(".workboard-board-draft__name input"),
      "board name",
    );
    name.value = board.name;
    name.dispatchEvent(new Event("input", { bubbles: true }));
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await vi.advanceTimersByTimeAsync(0);
    expect(host.ui.pinNavigation).toHaveBeenCalledExactlyOnceWith("board-created");
    expect(pinnedNavigation).toMatchObject({
      id: "board-created",
      parent: "workboard",
      label: "Created (cards)",
      icon: "rocket",
      defaultVisible: false,
    });
    expect(siblingAtPin).toMatchObject({ label: "Created (sessions)" });

    stale.resolve({ cards: [], boards: [existing] });
    await vi.advanceTimersByTimeAsync(0);
    expect(registrations.get("navigation/board-created")).toBe(pinnedNavigation);
    refreshed.resolve({
      cards: [],
      boards: [existing, { ...board, total: 0, active: 0, archived: 0, byStatus: {} }],
    });
    await vi.advanceTimersByTimeAsync(0);
    register.mockClear();
    fixture.emit("plugin.workboard.changed", {});
    await vi.advanceTimersByTimeAsync(0);
    expect(register).not.toHaveBeenCalled();
    expect(host.ui.pinNavigation).toHaveBeenCalledOnce();
  } finally {
    mounted?.dispose?.();
    dispose?.();
  }
});

it("keeps accessories on the same recovered snapshot and retires pending activation reads", async () => {
  const fixture = workboardTestHost();
  const { host, connection, registrations } = fixture;
  connection.connected = true;
  const session = createGatewaySession();
  const card = createWorkboardCard({ title: "Linked card", sessionKey: session.key });
  const boards = [{ id: "default", total: 1, active: 1, archived: 0, byStatus: { todo: 1 } }];
  const request = vi.fn().mockResolvedValue({ cards: [card], boards });
  host.request = request as typeof host.request;
  const dispose = await workboardPlugin.activate(host);
  const container = document.createElement("div");
  const context = { sessionKey: session.key, session };
  const accessory = registrations.get("accessory/linked-card") as ControlUiAccessory;
  const mounted = accessory.mount(container, createViewContext(host, context));
  let disposed = false;
  try {
    await vi.waitFor(() => expect(container.textContent).toContain(card.title));
    expect([...registrations.keys()].filter((key) => key.startsWith("action/"))).toEqual([]);

    request.mockRejectedValueOnce(new Error("Temporary read failure"));
    fixture.emit("plugin.workboard.changed", {});
    await vi.waitFor(() => expect(request.mock.settledResults[1]?.type).toBe("rejected"));
    expect(container.textContent).toContain(card.title);

    request.mockResolvedValueOnce({ cards: [{ ...card, metadata: { archivedAt: 1 } }], boards });
    fixture.emit("plugin.workboard.changed", {});
    await vi.waitFor(() => expect(container.querySelector("a")).toBeNull());

    fixture.emit("plugin.workboard.changed", {});
    await vi.waitFor(() => expect(container.textContent).toContain(card.title));

    const pending = createDeferred<unknown>();
    request.mockReturnValueOnce(pending.promise);
    const count = request.mock.calls.length;
    fixture.emit("plugin.workboard.changed", {});
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(count + 1));
    mounted?.dispose?.();
    dispose?.();
    disposed = true;
    const invalidations = vi.mocked(host.ui.invalidate).mock.calls.length;
    pending.resolve({ cards: [{ ...card, title: "Retired response" }], boards });
    await pending.promise;
    fixture.emit("plugin.workboard.changed", {});
    fixture.notify();
    expect(request).toHaveBeenCalledTimes(count + 1);
    expect(vi.mocked(host.ui.invalidate).mock.calls.length).toBe(invalidations);
    expect(container.childElementCount).toBe(0);
    expect(fixture.events.get("plugin.workboard.changed")?.size).toBe(0);
    expect(fixture.listeners.size).toBe(0);
  } finally {
    if (!disposed) {
      mounted?.dispose?.();
      dispose?.();
    }
  }
});
