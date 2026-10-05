import "../../test/dom.setup.ts";
import { expectDefined } from "@openclaw/normalization-core";
import type {
  WorkboardSessionsBoard,
  WorkboardSessionsBoardRead,
} from "@openclaw/workboard-contract";
import type { ControlUiAgentPickerProps, ControlUiHost } from "openclaw/plugin-sdk/control-ui";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mountPage } from "./workboard-page.test-support.ts";

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
});
afterEach(() => vi.useRealTimers());

function sessionsPage(options: { boardId?: string; gatewayId?: string; profileId?: string } = {}) {
  const board: WorkboardSessionsBoard = {
    id: options.boardId ?? "sessions",
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
    people: [
      { identity: { type: "profile", id: "viewer" }, label: "Viewer", sessionCount: 2 },
      { identity: { type: "profile", id: "ada" }, label: "Ada", sessionCount: 1 },
      { identity: { type: "profile", id: "grace" }, sessionCount: 1 },
    ],
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
    warning:
      "Session facts are unavailable for 2 sessions: Gateway disconnected. Showing the last known placement.",
  };
  const page = mountPage({ boardId: board.id });
  const request = expectDefined(page.request.getMockImplementation(), "request");
  page.request.mockImplementation(async (method, params) => {
    if (method === "gateway.identity.get") {
      return { deviceId: options.gatewayId ?? "gateway-one" };
    }
    if (method === "users.self") {
      return { profile: { id: options.profileId ?? "viewer" } };
    }
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

function peoplePicker(page: ReturnType<typeof mountPage>) {
  return expectDefined(
    page.container.querySelector<
      HTMLElement & Parameters<ControlUiHost["components"]["mountSelectPicker"]>[1]
    >(".workboard-people-filter [data-test-select-picker]"),
    "people filter",
  );
}

it("renders the people facet, rereads the selected view and restores it only for its viewer, Gateway and board", async () => {
  const page = sessionsPage();
  await page.connect();
  expect(peoplePicker(page).options).toEqual([
    { value: "everyone", label: "Everyone" },
    { value: "me", label: "Involving me" },
    { value: "profile:ada", label: "Ada" },
    { value: "profile:grace", label: "grace" },
  ]);
  expect(page.request).toHaveBeenCalledWith("workboard.sessionsBoard.read", {
    boardId: "sessions",
    view: { includePeople: true },
  });
  peoplePicker(page).onSelect("me");
  await vi.advanceTimersByTimeAsync(0);
  expect(page.request).toHaveBeenLastCalledWith("workboard.sessionsBoard.read", {
    boardId: "sessions",
    view: { includePeople: true, involvingMe: true },
  });
  page.result.sessions.splice(0, 1);
  peoplePicker(page).onSelect("profile:ada");
  await vi.advanceTimersByTimeAsync(0);
  expect(page.request).toHaveBeenLastCalledWith("workboard.sessionsBoard.read", {
    boardId: "sessions",
    view: { includePeople: true, involvingProfileId: "ada" },
  });
  expect(
    page.container.querySelector('[data-session-column="working"]')?.getAttribute("aria-label"),
  ).toBe("Working, 0");
  expect(page.container.querySelectorAll(".workboard-session-tile")).toHaveLength(1);
  page.dispose();

  const restored = sessionsPage();
  await restored.connect();
  expect(peoplePicker(restored).value).toBe("profile:ada");
  expect(restored.request).toHaveBeenCalledWith("workboard.sessionsBoard.read", {
    boardId: "sessions",
    view: { includePeople: true, involvingProfileId: "ada" },
  });
  restored.dispose();
  for (const options of [
    { boardId: "another-board" },
    { gatewayId: "another-gateway" },
    { profileId: "another-viewer" },
  ]) {
    const other = sessionsPage(options);
    await other.connect();
    expect(peoplePicker(other).value).toBe("everyone");
    other.dispose();
  }
  // A reconnect within one mount may belong to another viewer: the scope is reloaded,
  // the stale selection is not carried over, and the previous scope keeps its own choice.
  const reconnecting = sessionsPage();
  await reconnecting.connect();
  expect(peoplePicker(reconnecting).value).toBe("profile:ada");
  reconnecting.fixture.connection.connected = false;
  reconnecting.fixture.notify();
  await vi.advanceTimersByTimeAsync(0);
  const previous = expectDefined(reconnecting.request.getMockImplementation(), "request");
  reconnecting.request.mockImplementation(async (method, params) => {
    if (method === "users.self") {
      return { profile: { id: "colleague" } };
    }
    return previous(method, params);
  });
  await reconnecting.connect();
  expect(peoplePicker(reconnecting).value).toBe("everyone");
  peoplePicker(reconnecting).onSelect("me");
  await vi.advanceTimersByTimeAsync(0);
  reconnecting.dispose();
  const original = sessionsPage();
  await original.connect();
  expect(peoplePicker(original).value).toBe("profile:ada");
  original.dispose();
  const colleague = sessionsPage({ profileId: "colleague" });
  await colleague.connect();
  expect(peoplePicker(colleague).value).toBe("me");
  colleague.dispose();

  const everyone = sessionsPage();
  await everyone.connect();
  peoplePicker(everyone).onSelect("everyone");
  await vi.advanceTimersByTimeAsync(0);
  expect(everyone.request).toHaveBeenLastCalledWith("workboard.sessionsBoard.read", {
    boardId: "sessions",
    view: { includePeople: true },
  });
});

it("restores the destination board's saved people filter when boards change while identity is still loading", async () => {
  localStorage.setItem(
    `openclaw.workboard.sessions.people:${JSON.stringify(["gateway-one", "viewer", "sessions-b"])}`,
    "me",
  );
  const page = sessionsPage();
  const boardB = { ...page.board, id: "sessions-b", name: "Sessions B" };
  const previous = expectDefined(page.request.getMockImplementation(), "request");
  let releaseIdentity = () => {};
  const identityGate = new Promise<void>((resolve) => {
    releaseIdentity = resolve;
  });
  page.request.mockImplementation(async (method, params) => {
    if (method === "gateway.identity.get" || method === "users.self") {
      await identityGate;
    }
    if (method === "workboard.cards.list") {
      return {
        cards: [],
        boards: [page.board, boardB].map((board) =>
          Object.assign({ total: 0, active: 0, archived: 0, byStatus: {} }, board),
        ),
      };
    }
    if (method === "workboard.sessionsBoard.read") {
      const boardId = (params as { boardId: string }).boardId;
      return {
        ...structuredClone(page.result),
        board: boardId === "sessions-b" ? boardB : page.board,
      };
    }
    return previous(method, params);
  });
  await page.connect();
  page.navigate("sessions-b");
  await vi.advanceTimersByTimeAsync(0);
  releaseIdentity();
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(0);
  expect(peoplePicker(page).value).toBe("me");
  expect(page.request).toHaveBeenLastCalledWith("workboard.sessionsBoard.read", {
    boardId: "sessions-b",
    view: { includePeople: true, involvingMe: true },
  });
  page.dispose();
});

it.each(["people", "cards"] as const)(
  "discards a stale sessions read after switching %s",
  async (destination) => {
    const page = sessionsPage();
    const pending = createDeferred<WorkboardSessionsBoardRead>();
    const request = expectDefined(page.request.getMockImplementation(), "request");
    const unavailable =
      destination === "people"
        ? vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
            throw new Error("Storage unavailable");
          })
        : undefined;
    page.request.mockImplementation((method, params) =>
      method === "workboard.sessionsBoard.read" &&
      (destination === "cards" ||
        (params as { view?: { involvingMe?: boolean } }).view?.involvingMe)
        ? pending.promise
        : request(method, params),
    );
    await page.connect();
    unavailable?.mockRestore();
    const blockedWrite =
      destination === "people"
        ? vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
            throw new Error("Storage unavailable");
          })
        : undefined;
    if (destination === "people") {
      peoplePicker(page).onSelect("me");
      await vi.advanceTimersByTimeAsync(0);
      peoplePicker(page).onSelect("profile:ada");
    } else {
      page.navigate("default");
    }
    await vi.advanceTimersByTimeAsync(0);
    pending.resolve(destination === "people" ? { ...page.result, sessions: [] } : page.result);
    await vi.advanceTimersByTimeAsync(0);
    if (destination === "people") {
      expect(peoplePicker(page).value).toBe("profile:ada");
      expect(page.container.querySelectorAll(".workboard-session-tile")).toHaveLength(2);
    } else {
      expect(page.container.querySelector(".workboard-sessions")).toBeNull();
      expect(page.container.textContent).not.toContain("Fix retries");
      expect(page.container.querySelector(".workboard-create")).not.toBeNull();
    }
    blockedWrite?.mockRestore();
  },
);

function button(page: ReturnType<typeof mountPage>, label: string) {
  return expectDefined(
    [...page.container.querySelectorAll<HTMLButtonElement>("button")].find(
      (entry) => (entry.getAttribute("aria-label") ?? entry.textContent?.trim()) === label,
    ),
    label,
  );
}

it("recovers empty-board facts through one plugin refresh of the selected people view", async () => {
  const page = sessionsPage();
  const sessions = page.result.sessions.splice(0);
  await page.connect();
  const statuses = () =>
    [...page.container.querySelectorAll('[role="status"]')].map((entry) =>
      entry.textContent?.trim(),
    );
  expect(statuses()).toContain(page.result.warning);
  expect(page.container.querySelectorAll(".workboard-session-tile")).toHaveLength(0);

  peoplePicker(page).onSelect("me");
  await vi.advanceTimersByTimeAsync(0);
  page.request.mockClear();
  page.result.sessions.push(...sessions);
  page.result.sessions[0]!.observerDigest!.headline = "New canonical headline";
  delete page.result.warning;
  page.fixture.emit("session.observer", { sessionKey: "agent:main:working", revision: 1 });
  page.fixture.emit("plugin.workboard.changed", { epoch: "facts", revision: 1 });
  await vi.advanceTimersByTimeAsync(0);
  expect(page.container.querySelectorAll(".workboard-session-tile")).toHaveLength(2);
  expect(statuses()).toEqual([]);
  expect(page.reads()).toBe(1);
  expect(page.container.textContent).toContain("New canonical headline");
  await vi.advanceTimersByTimeAsync(1000);
  expect(page.reads()).toBe(1);
  expect(page.request).toHaveBeenLastCalledWith("workboard.sessionsBoard.read", {
    boardId: "sessions",
    view: { includePeople: true, involvingMe: true },
  });
});

it("skips unchanged board events, preserves tiles on conditional reads and rereads after reconnect", async () => {
  const page = sessionsPage();
  const revision = { epoch: "sessions", revision: 1, boardId: "sessions", scope: "everyone" };
  Object.assign(page.result, { revision });
  await page.connect();
  const request = expectDefined(page.request.getMockImplementation(), "request");
  page.request.mockImplementation(async (method, params) =>
    method === "workboard.sessionsBoard.read" &&
    (params as { sinceRevision?: unknown }).sinceRevision
      ? { unchanged: true, revision }
      : request(method, params),
  );
  page.request.mockClear();
  page.fixture.emit("plugin.workboard.changed", {
    epoch: "sessions",
    revision: 2,
    cardsRevision: 2,
    sessionsRevision: 1,
  });
  page.fixture.emit("sessions.changed", { reason: "category", sessionKey: "agent:main:working" });
  await vi.advanceTimersByTimeAsync(5_000);
  expect(page.reads()).toBe(0);
  page.fixture.emit("plugin.workboard.changed", { epoch: "sessions", revision: 3 });
  await vi.advanceTimersByTimeAsync(0);
  expect(page.request).toHaveBeenLastCalledWith("workboard.sessionsBoard.read", {
    boardId: "sessions",
    view: { includePeople: true },
    sinceRevision: revision,
  });
  expect(page.container.querySelectorAll(".workboard-session-tile")).toHaveLength(2);
  expect(page.container.textContent).toContain("Checking reconnects");

  page.fixture.connection.connected = false;
  page.fixture.notify();
  await page.connect();
  expect(page.request).toHaveBeenLastCalledWith("workboard.sessionsBoard.read", {
    boardId: "sessions",
    view: { includePeople: true },
  });
  peoplePicker(page).onSelect("me");
  await vi.advanceTimersByTimeAsync(0);
  expect(page.request).toHaveBeenLastCalledWith("workboard.sessionsBoard.read", {
    boardId: "sessions",
    view: { includePeople: true, involvingMe: true },
  });
});

it("fences an older conditional read when a session moves", async () => {
  const page = sessionsPage();
  const revision = { epoch: "sessions", revision: 1, boardId: "sessions", scope: "everyone" };
  Object.assign(page.result, { revision });
  await page.connect();
  const pending = createDeferred<unknown>();
  const request = expectDefined(page.request.getMockImplementation(), "request");
  page.request.mockImplementation(async (method, params) => {
    if (
      method === "workboard.sessionsBoard.read" &&
      (params as { sinceRevision?: unknown }).sinceRevision
    ) {
      return pending.promise;
    }
    if (method === "workboard.sessionsBoard.move") {
      page.result.sessions[0]!.columnId = "done";
    }
    return request(method, params);
  });
  page.fixture.emit("plugin.workboard.changed", {
    epoch: "sessions",
    revision: 2,
    sessionsRevision: 2,
  });
  await vi.advanceTimersByTimeAsync(0);
  const tile = expectDefined(page.container.querySelector("[data-session-key]"), "session tile");
  tile.dispatchEvent(new Event("dragstart", { bubbles: true }));
  await vi.advanceTimersByTimeAsync(0);
  expectDefined(
    page.container.querySelector('[data-session-column="done"]'),
    "destination",
  ).dispatchEvent(new Event("drop", { bubbles: true, cancelable: true }));
  await vi.advanceTimersByTimeAsync(0);
  expect(
    page.container.querySelector('[data-session-column="done"]')?.getAttribute("aria-label"),
  ).toBe("Done, 2");
  pending.resolve({ unchanged: true, revision });
  await vi.advanceTimersByTimeAsync(0);
  expect(
    page.container.querySelector('[data-session-column="done"]')?.getAttribute("aria-label"),
  ).toBe("Done, 2");
  expect(page.request).toHaveBeenCalledWith("workboard.sessionsBoard.read", {
    boardId: "sessions",
    view: { includePeople: true },
  });
});

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
    "Gateway disconnected",
  );
  expect(page.fixture.host.components.mountAgentAvatar).toHaveBeenCalledWith(
    expect.any(HTMLElement),
    { agentId: "writer", label: "writer" },
  );
  expect(
    page.container.querySelector(
      ".workboard-create, .workboard-dispatch, .workboard-card, .workboard-status-tabs, .workboard-board-agent, .workboard-refresh",
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

it("pins a dragged session and rereads the selected people view", async () => {
  const page = sessionsPage();
  await page.connect();
  peoplePicker(page).onSelect("me");
  await vi.advanceTimersByTimeAsync(0);
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
  expect(page.request).toHaveBeenLastCalledWith("workboard.sessionsBoard.read", {
    boardId: "sessions",
    view: { includePeople: true, involvingMe: true },
  });
  expect(page.request.mock.calls.some(([method]) => method === "workboard.cards.move")).toBe(false);
});

it("links up to four pull requests by state without opening or dragging the session", async () => {
  const page = sessionsPage();
  page.result.sessions[0]!.pullRequests = [
    { number: 10, state: "closed" },
    { number: 11, state: "merged" },
    { number: 12, state: "draft" },
    {
      number: 13,
      state: "open",
      url: "https://github.com/example/project/pull/13",
      title: "Fix session retries",
    },
    { number: 14, state: "closed" },
    { number: 15, state: "closed" },
  ];
  await page.connect();
  const tile = expectDefined(
    page.container.querySelector<HTMLElement>('[data-session-key="agent:main:working"]'),
    "session tile",
  );
  const pullRequests = [...tile.querySelectorAll<HTMLElement>(".workboard-session-pr")];
  expect(pullRequests.map((entry) => entry.textContent?.trim())).toEqual([
    "#13 · Open",
    "#12 · Draft",
    "#11 · Merged",
    "#10 · Closed",
  ]);
  expect(tile.querySelector(".workboard-session-tile__prs")?.textContent).toContain("+2");
  const link = expectDefined(tile.querySelector<HTMLAnchorElement>("a"), "pull-request link");
  expect(link.href).toBe("https://github.com/example/project/pull/13");
  expect(link.target).toBe("_blank");
  expect(link.rel).toBe("noreferrer");
  expect(link.title).toBe("Fix session retries");
  expect(link.closest("button")).toBeNull();
  expect(pullRequests.slice(1).every((entry) => entry.tagName === "SPAN")).toBe(true);

  const icon = expectDefined(link.querySelector("svg"), "pull-request state icon");
  const click = new MouseEvent("click", { bubbles: true, cancelable: true });
  icon.dispatchEvent(click);
  expect(click.defaultPrevented).toBe(false);
  expect(page.fixture.host.sessions.open).not.toHaveBeenCalled();
  link.dispatchEvent(new Event("dragstart", { bubbles: true, cancelable: true }));
  expectDefined(
    page.container.querySelector('[data-session-column="done"]'),
    "destination",
  ).dispatchEvent(new Event("drop", { bubbles: true, cancelable: true }));
  await vi.advanceTimersByTimeAsync(0);
  expect(
    page.request.mock.calls.some(([method]) => method === "workboard.sessionsBoard.move"),
  ).toBe(false);
  expectDefined(tile.querySelector<HTMLButtonElement>("button"), "session title").click();
  expect(page.fixture.host.sessions.open).toHaveBeenCalledExactlyOnceWith({
    sessionKey: "agent:main:working",
    agentId: "main",
  });
});

it.each(["cards", "sessions"] as const)(
  "registers and pins a created %s board before its catalog refresh completes",
  async (kind) => {
    const page = sessionsPage();
    await page.connect();
    const savedBoard = {
      id: `created-${kind}`,
      name: "My board",
      kind,
      createdAt: 1,
      updatedAt: 1,
    };
    const refreshed = createDeferred<unknown>();
    const request = expectDefined(page.request.getMockImplementation(), "request");
    let created = false;
    page.request.mockImplementation(async (method, params) => {
      if (method === "workboard.boards.upsert") {
        created = true;
        return { board: savedBoard };
      }
      if (method === "workboard.cards.list" && created) {
        return refreshed.promise;
      }
      return request(method, params);
    });
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
    name.value = "My board";
    name.dispatchEvent(new Event("input", { bubbles: true }));
    expectDefined(
      form.querySelector<HTMLInputElement>(`input[value="${kind}"]`),
      "board kind",
    ).click();
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await vi.advanceTimersByTimeAsync(0);
    expect(page.request).toHaveBeenCalledWith("workboard.boards.upsert", {
      id: expect.stringMatching(/^board-/),
      name: "My board",
      ...(kind === "sessions" ? { kind } : {}),
    });
    expect(
      page.request.mock.calls.some(([method]) => method === "workboard.sessionsBoard.update"),
    ).toBe(false);
    expect(page.registerBoardNavigation).toHaveBeenCalledExactlyOnceWith(savedBoard);
    expect(page.fixture.host.ui.pinNavigation).toHaveBeenCalledExactlyOnceWith(
      `board-created-${kind}`,
    );
    expect(page.registerBoardNavigation.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(page.fixture.host.ui.pinNavigation).mock.invocationCallOrder[0]!,
    );
    expect(page.fixture.host.navigation.openPage).not.toHaveBeenCalled();
    refreshed.resolve({ cards: [], boards: [page.board] });
    await vi.advanceTimersByTimeAsync(0);
    expect(page.fixture.host.navigation.openPage).toHaveBeenCalledWith(
      { id: "workboard", path: [savedBoard.id] },
      { replace: true, preserveSearch: true },
    );
  },
);

it("validates session columns inline and preserves their ids and rules when labels change", async () => {
  const page = sessionsPage();
  expectDefined(page.board.sessions.columns[0], "working column").match = [
    { run: ["active"] },
    { health: ["on-track"] },
  ];
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
  form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  await vi.advanceTimersByTimeAsync(0);
  expect(page.request).toHaveBeenCalledWith("workboard.sessionsBoard.update", {
    boardId: "sessions",
    patch: {
      columns: [
        { ...page.board.sessions.columns[0], label: "Building" },
        page.board.sessions.columns[1],
      ],
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
  peoplePicker(page).onSelect("me");
  await vi.advanceTimersByTimeAsync(0);
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
