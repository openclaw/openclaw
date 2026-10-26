import { expectDefined } from "@openclaw/normalization-core";
import { createDeferred } from "openclaw/plugin-sdk/concurrency-runtime";
import "../../test/dom.setup.ts";
import type {
  ControlUiAgentPickerProps,
  ControlUiComponents,
} from "openclaw/plugin-sdk/control-ui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createGatewaySession,
  createWorkboardCard,
} from "../../lib/workboard/test/index-helpers.ts";
import { afterWorkboardUpdate as settle } from "../../test/settle.ts";
import {
  element,
  enterText,
  submitForm,
  expectText,
  expectAbsent,
  expectValue,
} from "./view-dom.test-support.ts";
import { openCardMenu } from "./view.test-support.ts";
import {
  mountPage,
  observeSessions,
  openBoardEditor,
  openSessionTab,
  openSessionButton,
  visibleToast,
  sessionPicker,
} from "./workboard-page.test-support.ts";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

type Page = ReturnType<typeof mountPage>;
function connect(page: Page) {
  page.fixture.connection.connected = true;
  page.fixture.notify();
}
function listBoards(page: Page, appearance: { icon?: string; color?: string } = {}) {
  const counts = { total: 0, active: 0, archived: 0, byStatus: {} };
  const board = { id: "planning", name: "Planning", ...counts, ...appearance };
  const request = expectDefined(page.request.getMockImplementation(), "request implementation");
  page.request.mockImplementation(async (method, params) =>
    method === "workboard.cards.list" ? { cards: [], boards: [board] } : request(method, params),
  );
}
const errorMessage = (page: Page) =>
  visibleToast(page.container)?.querySelector('[role="alert"]')?.textContent;
const visibleCards = (page: Page) => page.container.querySelectorAll(".workboard-card");

it("loads, refreshes, and searches cards through the plugin's authenticated host", async () => {
  const page = mountPage({ connected: true });
  const container = page.container;
  await settle(() => expect(container.textContent).toContain("Initial card"));
  page.focus();
  expect(document.activeElement).toBe(container.querySelector(".workboard-search-trigger"));
  page.cards([createWorkboardCard({ title: "Updated card" })]);
  page.fixture.emit("plugin.workboard.changed", { epoch: "current", revision: 1 });
  await settle(() => expect(container.textContent).toContain("Updated card"));
  expect(container.textContent).not.toContain("Initial card");
  element<HTMLButtonElement>(container, ".workboard-search-trigger").click();
  const input = await settle(() => {
    const current = element<HTMLInputElement>(container, "#workboard-search-input");
    expect(document.activeElement).toBe(current);
    return current;
  });
  page.focus();
  expect(document.activeElement).toBe(input);
  enterText(input, "Updated");
  await settle(() => {
    expect(page.workboard.state.query).toBe("Updated");
    expectText(container, ".workboard-filter-chip", "Updated");
  });
  expect(container.querySelector("#workboard-search-input")).toBe(input);
  expect(document.activeElement).toBe(input);
  input.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
  );
  await settle(() =>
    expect(document.activeElement).toBe(
      element<HTMLButtonElement>(container, ".workboard-search-trigger"),
    ),
  );
  expect(page.workboard.state.query).toBe("");
});

it("clears filters without changing scope and recovers a scope missing from the roster", async () => {
  const page = mountPage();
  const container = page.container;
  const host = page.fixture.host;
  page.agents([
    { id: "main", name: "Molty" },
    { id: "writer", name: "Writer" },
  ]);
  page.cards(
    (
      [
        ["main-high", "Molty high task", "main", "high"],
        ["writer-urgent", "Writer urgent task", "writer", "urgent"],
        ["writer-low", "Writer low task", "writer", "low"],
      ] as const
    ).map(([id, title, agentId, priority]) =>
      createWorkboardCard({ id, title, agentId, priority }),
    ),
  );
  connect(page);
  await settle(() => expect(visibleCards(page)).toHaveLength(3));
  for (const priority of ["High", "Urgent"]) {
    element<HTMLInputElement>(
      container,
      `.workboard-filter-section__options[aria-label="Priority"] label[title="${priority}"] input`,
    ).click();
    await settle(() =>
      expect(page.workboard.state.priorityFilter.size).toBe(priority === "High" ? 1 : 2),
    );
  }
  const picker = element<HTMLElement & ControlUiAgentPickerProps>(
    container,
    ".workboard-agent-filter [data-test-agent-picker]",
  );
  picker.onSelect("main");
  await settle(() => {
    expect(visibleCards(page)).toHaveLength(1);
    expect(container.querySelector('button[aria-label="Filters, 1 active"]')).not.toBeNull();
    expect(
      container.querySelector(
        '.workboard-filter-chip--mobile button[aria-label="Remove filter: Agent: Molty"]',
      ),
    ).not.toBeNull();
  });
  element<HTMLButtonElement>(container, ".workboard-filter-clear").click();
  expect(host.agents.setScope).toHaveBeenLastCalledWith("main");
  await settle(() => {
    expect(visibleCards(page)).toHaveLength(1);
    expectText(container, ".workboard-board", "Molty high task");
    expect(container.querySelector(".workboard-board")?.textContent).not.toContain(
      "Writer urgent task",
    );
    expect(container.querySelector(".workboard-board")?.textContent).not.toContain(
      "Writer low task",
    );
    expectAbsent(container, 'button[aria-label="Filters, 1 active"]');
    expect(
      container.querySelector(
        '.workboard-filter-chip--mobile button[aria-label="Remove filter: Agent: Molty"]',
      ),
    ).not.toBeNull();
  });
  expect(page.workboard.state.priorityFilter.size).toBe(0);
  page.agents([{ id: "writer" }]);
  await host.agents.refresh();
  await settle(() => expect(visibleCards(page)).toHaveLength(1));
  expectText(container, ".workboard-board", "Molty high task");
  const missing = element<HTMLElement & ControlUiAgentPickerProps>(
    container,
    ".workboard-agent-filter [data-test-agent-picker]",
  );
  expect(missing.value).toBe("main");
  expect(missing.options).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ value: "main", label: "main" }),
      expect.objectContaining({ value: "", label: "All agents" }),
    ]),
  );
  missing.onSelect("");
  await settle(() => expect(visibleCards(page)).toHaveLength(3));
  expect(host.agents.scopeId).toBeNull();
  host.agents.setScope("main");
  await settle(() => expect(visibleCards(page)).toHaveLength(1));
  element<HTMLButtonElement>(container, 'button[aria-label="Remove filter: Agent: main"]').click();
  expect(host.agents.setScope).toHaveBeenLastCalledWith(null);
  await settle(() => {
    expect(visibleCards(page)).toHaveLength(3);
    expectAbsent(container, ".workboard-filter-chip--mobile", ".workboard-scope");
  });
});

it("suspends the session summary when its page is hidden and resumes on return", async () => {
  const page = mountPage();
  const session = createGatewaySession({ key: "agent:main:retained", agentId: "main" });
  observeSessions(page, { sessions: [session], hasMore: false });
  Object.assign(page.fixture.host.sessions, { rows: [session] });
  const card = createWorkboardCard({ sessionKey: session.key });
  page.cards([card]);
  page.workboard.state.detailCardId = card.id;
  connect(page);
  await openSessionTab(page);
  const summaries = () => [
    ...page.container.querySelectorAll<HTMLElement & { presented: boolean }>(
      "[data-test-session-summary]",
    ),
  ];
  await settle(() => expect(summaries().some((summary) => summary.presented)).toBe(true));
  page.present(false);
  await settle(() => expect(summaries().some((summary) => summary.presented)).toBe(false));
  page.fixture.emit("session.message", { sessionKey: session.key, agentId: "main" });
  await Promise.resolve();
  expect(summaries().some((summary) => summary.presented)).toBe(false);
  page.present(true);
  await settle(() => expect(summaries().some((summary) => summary.presented)).toBe(true));
});

it("resolves an open subagent:workboard-default-writer card independently of the filtered session roster", async () => {
  const link = "subagent:workboard-default-writer";
  const key = "agent:writer:subagent:workboard-default-writer";
  const page = mountPage();
  const host = page.fixture.host;
  const session = createGatewaySession({ key, agentId: "writer" });
  const primaryRows = [createGatewaySession({ key: "global", agentId: "main", kind: "global" })];
  const observe = observeSessions(page, { sessions: [session], hasMore: false });
  Object.assign(host.sessions, { rows: primaryRows });
  const card = createWorkboardCard({ agentId: "main", sessionKey: link });
  page.cards([card]);
  page.workboard.state.detailCardId = card.id;
  connect(page);

  await openSessionTab(page);
  expect(observe).toHaveBeenCalledWith(
    expect.objectContaining({
      search: link,
      archived: "all",
      limit: 2,
      includeGlobal: false,
      includeUnknown: false,
    }),
    expect.any(Function),
  );
  expect(host.sessions.rows).toEqual(primaryRows);
  expect(host.sessions.refresh).not.toHaveBeenCalled();
  expectDefined(openSessionButton(page.container), "open resolved session").click();
  expect(host.sessions.open).toHaveBeenCalledWith({
    sessionKey: key,
    agentId: "writer",
  });
});

it("keeps a bare unknown link unresolved despite an ambient roster owner", async () => {
  const key = "unknown";
  const page = mountPage();
  const container = page.container;
  const ambient = createGatewaySession({ key, kind: key, agentId: "main" });
  const exact = createGatewaySession({ key: "agent:writer:existing", agentId: "writer" });
  Object.assign(page.fixture.host.sessions, { rows: [ambient, exact] });
  const observe = observeSessions(page, { sessions: [ambient], hasMore: false });
  const card = createWorkboardCard({ agentId: "writer", sessionKey: key });
  page.cards([card]);
  connect(page);

  await settle(() => expectText(container, ".workboard-card", "Unknown"));
  const menu = openCardMenu(container.querySelector(".workboard-card")!);
  expect(openSessionButton(container)).toBeUndefined();
  expectAbsent(container, 'button[aria-label="Stop session"]');
  element<HTMLButtonElement>(menu, 'button[aria-label="View details"]').click();
  await settle(() =>
    expect(
      container.querySelector(".workboard-detail .workboard-session-badge")?.textContent?.trim(),
    ).toBe("Ambiguous"),
  );
  expect(container.querySelector(".workboard-detail__session-row")?.getAttribute("title")).toBe(
    "Edit the card to select an exact session",
  );
  expect(observe).not.toHaveBeenCalled();
  expect(page.fixture.host.components.mountSessionSummary).not.toHaveBeenCalled();
  expect(openSessionButton(container)).toBeUndefined();
  element<HTMLButtonElement>(container, '.workboard-detail button[aria-label="Edit card"]').click();
  await settle(() => expect(sessionPicker(container)).toBeDefined());
  const select = expectDefined(sessionPicker(container), "session link editor");
  expect(select.value).toBe(key);
  expect(select.options.map((option) => option.value)).toContain(exact.key);
});

it.each([
  ["deletion-filtered", ["writer"], 2, "Unknown"],
  ["ambiguous", ["writer", "other"], 2, "Ambiguous"],
  ["empty", [], 0, "Unavailable"],
] as const)(
  "keeps an %s linked-session query unresolved",
  async (_name, owners, totalCount, label) => {
    const page = mountPage();
    const container = page.container;
    const localKey = "subagent:workboard-default-unresolved";
    const observe = observeSessions(page, {
      sessions: owners.map((owner) => createGatewaySession({ key: `agent:${owner}:${localKey}` })),
      hasMore: false,
      totalCount,
    });
    Object.assign(page.fixture.host.sessions, {
      rows: [createGatewaySession({ key: "agent:main:unrelated" })],
    });
    const card = createWorkboardCard({ sessionKey: localKey });
    page.cards([card]);
    page.workboard.state.detailCardId = card.id;
    connect(page);

    await settle(() => {
      expect(observe).toHaveBeenCalledOnce();
      expect(
        container.querySelector(".workboard-detail .workboard-session-badge")?.textContent?.trim(),
      ).toBe(label);
    });
    expect(page.fixture.host.components.mountSessionSummary).not.toHaveBeenCalled();

    container.querySelector<HTMLButtonElement>('button[aria-label="Edit card"]')!.click();
    await settle(() => expect(sessionPicker(container)).toBeDefined());
    const select = expectDefined(sessionPicker(container), "session picker");
    expect(select.value).toBe(localKey);
    for (const owner of owners) {
      expect(select.options.map((option) => option.value)).toContain(`agent:${owner}:${localKey}`);
    }
  },
);

it("releases the prior session query when another card takes the drawer", async () => {
  const page = mountPage();
  const firstKey = "subagent:workboard-default-first";
  const secondKey = "subagent:workboard-default-second";
  const first = createWorkboardCard({ id: "first", sessionKey: firstKey });
  const second = createWorkboardCard({ id: "second", sessionKey: secondKey });
  const releaseFirst = vi.fn();
  const observe = observeSessions(page, {
    sessions: [createGatewaySession({ key: `agent:writer:${secondKey}` })],
    hasMore: false,
  }).mockImplementationOnce((_query, listener) => {
    listener({ result: null, loading: true, error: null });
    return { refresh: vi.fn(async () => undefined), dispose: releaseFirst };
  });
  page.cards([first, second]);
  page.workboard.state.detailCardId = first.id;
  connect(page);
  await settle(() => expect(observe).toHaveBeenCalledOnce());

  page.workboard.state.detailCardId = second.id;
  page.workboard.notify();
  await openSessionTab(page);
  expectDefined(openSessionButton(page.container), "second session").click();
  expect(page.fixture.host.sessions.open).toHaveBeenCalledWith({
    sessionKey: `agent:writer:${secondKey}`,
  });
  expect(observe).toHaveBeenCalledTimes(2);
  expect(releaseFirst).toHaveBeenCalledOnce();
});

it("keeps failed metadata visible through card refreshes and recovers it with page Refresh", async () => {
  const page = mountPage();
  const container = page.container;
  page.agents([{ id: "main", name: "Configured operator" }]);
  page.cards([createWorkboardCard({ title: "Initial card", agentId: "main" })]);
  const metadata = createDeferred<unknown>();
  const request = expectDefined(page.request.getMockImplementation(), "request implementation");
  let metadataAvailable = false;
  page.request.mockImplementation((method) =>
    method === "agents.list" && !metadataAvailable ? metadata.promise : request(method),
  );
  connect(page);
  await settle(() => expect(container.textContent).toContain("Initial card"));
  metadata.reject(new Error("Agent metadata temporarily unavailable"));
  await settle(() =>
    expect(visibleToast(container)?.textContent).toContain(
      "Agent metadata temporarily unavailable",
    ),
  );

  page.cards([createWorkboardCard({ title: "Updated card", agentId: "main" })]);
  page.fixture.emit("plugin.workboard.changed", { epoch: "current", revision: 1 });
  await settle(() => expect(container.textContent).toContain("Updated card"));
  expect(visibleToast(container)?.textContent).toContain("Agent metadata temporarily unavailable");
  expectAbsent(container, '.workboard-card [role="img"][aria-label="Configured operator"]');
  expect(page.request.mock.calls.filter(([method]) => method === "agents.list")).toHaveLength(1);

  metadataAvailable = true;
  container.querySelector<HTMLButtonElement>('button[aria-label="Refresh"]')!.click();
  await settle(() =>
    expect(
      container.querySelector('.workboard-card [role="img"][aria-label="Configured operator"]'),
    ).not.toBeNull(),
  );
  expect(visibleToast(container)?.textContent ?? "").not.toContain(
    "Agent metadata temporarily unavailable",
  );
  expect(container.textContent).toContain("Updated card");
  expect(page.request.mock.calls.filter(([method]) => method === "agents.list")).toHaveLength(2);
});

it("shows independent metadata and linked-session failures together", async () => {
  const page = mountPage();
  const card = createWorkboardCard({ sessionKey: "agent:main:unavailable-session" });
  page.cards([card]);
  page.workboard.state.detailCardId = card.id;
  const request = expectDefined(page.request.getMockImplementation(), "request implementation");
  page.request.mockImplementation((method, params) =>
    method === "agents.list"
      ? Promise.reject(new Error("Agent metadata temporarily unavailable"))
      : request(method, params),
  );
  vi.mocked(page.fixture.host.sessions.observe).mockImplementation((_query, listener) => {
    listener({ result: null, loading: false, error: "Linked session temporarily unavailable" });
    return { refresh: vi.fn(async () => undefined), dispose: vi.fn() };
  });
  connect(page);

  await settle(() => {
    const message = errorMessage(page);
    expect(message).toContain("Agent metadata temporarily unavailable");
    expect(message).toContain("Linked session temporarily unavailable");
  });
});

it("keeps page failures visible in the board editor and prioritizes its save failure", async () => {
  const page = mountPage({ boardId: "planning" });
  listBoards(page);
  const failedSave = createDeferred<unknown>();
  const retriedSave = createDeferred<unknown>();
  const successfulSave = createDeferred<unknown>();
  let saves = 0;
  const request = expectDefined(page.request.getMockImplementation(), "request implementation");
  page.request.mockImplementation(async (method, params) => {
    if (method === "agents.list") {
      throw new Error("Agent metadata temporarily unavailable");
    }
    if (method === "workboard.boards.upsert") {
      return [failedSave, retriedSave, successfulSave][saves++]!.promise;
    }
    return request(method, params);
  });
  connect(page);
  const form = await openBoardEditor(page);
  await settle(() => {
    expect(errorMessage(page)).toBe("Agent metadata temporarily unavailable");
  });
  const name = element<HTMLInputElement>(form, ".workboard-board-draft__name input");
  name.value = "Release planning";
  name.dispatchEvent(new Event("input", { bubbles: true }));
  submitForm(form);
  submitForm(form);
  expect(saves).toBe(1);
  await settle(() => {
    expect(name.disabled).toBe(true);
    expect(form.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(true);
  });
  failedSave.reject(new Error("Board update denied"));
  await settle(() => {
    expect(errorMessage(page)).toBe("Board update denied");
  });
  expect(name.value).toBe("Release planning");
  element<HTMLButtonElement>(visibleToast(page.container), "button").click();
  submitForm(form);
  await settle(() => {
    expect(saves).toBe(2);
    expect(name.disabled).toBe(true);
    expect(errorMessage(page)).toBe("Agent metadata temporarily unavailable");
  });
  expect(name.value).toBe("Release planning");
  retriedSave.reject(new Error("Board update denied"));
  await settle(() => {
    expect(errorMessage(page)).toBe("Board update denied");
  });
  submitForm(form);
  successfulSave.resolve({ board: { id: "planning", name: "Release planning" } });
  await settle(() => expectAbsent(page.container, ".workboard-board-draft"));
});

it.each(["canWrite", "connected"] as const)(
  "preserves a board draft without saving when %s is revoked",
  async (capability) => {
    const page = mountPage({ boardId: "planning" });
    listBoards(page);
    connect(page);
    const form = await openBoardEditor(page);
    const name = element<HTMLInputElement>(form, "input");
    name.value = "Release planning";
    name.dispatchEvent(new Event("input", { bubbles: true }));
    page.fixture.connection[capability] = false;
    submitForm(form);
    expect(
      page.request.mock.calls.filter(([method]) => method === "workboard.boards.upsert"),
    ).toHaveLength(0);
    page.fixture.notify();
    await settle(() =>
      expect(form.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(true),
    );
    expect(name.value).toBe("Release planning");
    page.fixture.connection[capability] = true;
    page.fixture.notify();
    await settle(() =>
      expect(form.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(false),
    );
    submitForm(form);
    await settle(() => {
      expect(page.request).toHaveBeenCalledWith("workboard.boards.upsert", {
        id: "planning",
        name: "Release planning",
      });
      expectAbsent(page.container, ".workboard-board-draft");
    });
  },
);

it("requires a canonical refresh after reconnect before mutations resume", async () => {
  const page = mountPage({ connected: true });
  const state = page.workboard.state;
  await settle(() => expect(state.loaded).toBe(true));
  page.fixture.connection.connected = false;
  page.fixture.notify();
  expect(state.mutationReadiness).toBe("canonical_reload_required");
  page.cards([createWorkboardCard({ title: "Reconnected card" })]);
  connect(page);
  await settle(() => expect(page.container.textContent).toContain("Reconnected card"));
  expect(state.mutationReadiness).toBe("ready");
});

it("releases listeners and stops refreshes when its mount is disposed", async () => {
  const page = mountPage({ connected: true });
  await settle(() => expect(page.workboard.state.loaded).toBe(true));
  page.dispose();
  const count = page.request.mock.calls.length;
  page.fixture.emit("plugin.workboard.changed", { epoch: "current", revision: 9 });
  page.fixture.notify();
  await Promise.resolve();
  expect(page.request).toHaveBeenCalledTimes(count);
  expect(page.fixture.listeners.size).toBe(page.hostListeners);
  expect(page.fixture.events.get("plugin.workboard.changed")?.size).toBe(0);
  expect(page.container.childElementCount).toBe(0);
});

describe("selection reconciliation", () => {
  it.each(["scope", "board"] as const)(
    "preserves a submitted edit through %s changes and failed-save recovery",
    async (change) => {
      const page = mountPage();
      const container = page.container;
      const state = page.workboard.state;
      const card = createWorkboardCard({
        title: "Original task",
        notes: "Original notes",
        agentId: "writer",
        metadata: { automation: { boardId: "ops" } },
      });
      page.cards([card]);
      page.fixture.host.agents.setScope("writer");
      connect(page);
      await settle(() => expect(state.loaded).toBe(true));
      const menu = openCardMenu(container.querySelector(".workboard-card")!);
      element<HTMLButtonElement>(menu, 'button[aria-label="View details"]').click();
      await settle(() => expect(container.querySelector(".workboard-detail")).not.toBeNull());
      element<HTMLButtonElement>(
        container,
        '.workboard-detail button[aria-label="Edit card"]',
      ).click();
      await settle(() => expect(container.querySelector(".workboard-draft")).not.toBeNull());
      const form = () => element<HTMLFormElement>(container, ".workboard-draft");
      const title = element<HTMLInputElement>(form(), ".workboard-draft__title");
      const notes = element<HTMLTextAreaElement>(form(), ".workboard-draft__notes");
      enterText(title, "Submitted task");
      enterText(notes, "Keep these unsaved notes");
      const pending = createDeferred<unknown>();
      let updateResult = pending.promise;
      const request = expectDefined(page.request.getMockImplementation(), "host request");
      page.request.mockImplementation((method) =>
        method === "workboard.cards.update" ? updateResult : request(method),
      );
      submitForm(form());
      await settle(() =>
        expect(page.request).toHaveBeenCalledWith("workboard.cards.update", {
          id: card.id,
          expectedUpdatedAt: card.updatedAt,
          patch: { title: title.value, notes: notes.value },
        }),
      );
      if (change === "scope") {
        page.fixture.host.agents.setScope("main");
      } else {
        page.navigate("product");
      }
      await Promise.resolve();
      const pendingTitle =
        container.querySelector<HTMLInputElement>(".workboard-draft__title")?.value;
      const pendingNotes =
        container.querySelector<HTMLTextAreaElement>(".workboard-draft__notes")?.value;
      const pendingBusy = form().getAttribute("aria-busy");
      const enabledControls = [
        ...form().querySelectorAll(
          "input:enabled, textarea:enabled, select:enabled, button:enabled",
        ),
      ];
      pending.reject(new Error("Save unavailable; retry this edit."));
      await settle(() => {
        expect(state.draftSaving).toBe(false);
        expect(errorMessage(page)).toBe("Save unavailable; retry this edit.");
      });

      expect(pendingTitle).toBe("Submitted task");
      expect(pendingNotes).toBe("Keep these unsaved notes");
      expect(pendingBusy).toBe("true");
      expect(enabledControls).toHaveLength(0);
      const toast = expectDefined(visibleToast(container), "retry guidance");
      expect(toast.closest('[inert], [aria-hidden="true"]')).toBeNull();
      expect(toast.closest("[data-test-dialog]")).toBe(form().closest("[data-test-dialog]"));
      expectValue(form(), ".workboard-draft__title", "Submitted task");
      expectValue(form(), ".workboard-draft__notes", "Keep these unsaved notes");
      const saved = { ...card, title: title.value, notes: notes.value, updatedAt: 2 };
      updateResult = Promise.resolve({ card: saved });
      submitForm(form());
      await settle(() => expect(state.draftOpen).toBe(false));
      expect(
        page.request.mock.calls.filter(([method]) => method === "workboard.cards.update"),
      ).toHaveLength(2);
      expect(state.cards.find((entry) => entry.id === card.id)).toMatchObject(saved);
      expectAbsent(container, ".workboard-draft, .workboard-detail");
      const main = element(container, ".workboard-main");
      expect(main.textContent).not.toContain(saved.title);
    },
  );

  it("keeps a default-agent card's detail and draft when selecting its scope without metadata", async () => {
    const page = mountPage();
    const container = page.container;
    const host = page.fixture.host;
    const card = createWorkboardCard({ title: "Default-agent card" });
    page.cards([card]);
    page.fixture.connection.assistantAgentId = "research";
    vi.mocked(host.agents.refresh).mockRejectedValue(new Error("Agent metadata unavailable"));
    connect(page);
    await settle(() => expectText(container, ".workboard-card", card.title));
    openCardMenu(container.querySelector(".workboard-card")!)
      .querySelector<HTMLButtonElement>('button[aria-label="View details"]')!
      .click();
    await settle(() => expect(container.querySelector(".workboard-detail")).not.toBeNull());
    const selector = ".workboard-detail__note";
    const input = container.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector)!;
    enterText(input, "Keep this draft");
    expect(host.agents.defaultId).toBeNull();
    host.agents.setScope("research");
    await Promise.resolve();

    expectValue(container, selector, "Keep this draft");
    expectText(container, ".workboard-board", card.title);
    expect(host.agents.scopeId).toBe("research");
  });

  it("keeps only overlays inside scope main", async () => {
    const page = mountPage();
    const state = page.workboard.state;
    state.cards = [createWorkboardCard({ id: "writer-card", agentId: "writer" })];
    page.fixture.host.agents.setScope("writer");
    await Promise.resolve();
    Object.assign(state, {
      detailCardId: "writer-card",
      detailCommentBody: "Draft comment",
      draftOpen: true,
      editingCardId: "writer-card",
    });
    page.fixture.host.agents.setScope("main");
    await Promise.resolve();
    expect(state.detailCardId).toBe(null);
    expect(state.detailCommentBody).toBe("");
    expect(state.draftOpen).toBe(false);
  });

  it("preserves a new-card draft across board navigation", async () => {
    const page = mountPage({ boardId: "ops" });
    const state = page.workboard.state;
    Object.assign(state, { draftOpen: true, draftTitle: "New operations task" });
    page.navigate("product");
    await Promise.resolve();
    expect(state.draftOpen).toBe(true);
    expect(state.draftTitle).toBe("New operations task");
  });
});

it("titles the unfiltered page as all boards and a selected board by name", async () => {
  const page = mountPage({ connected: true });
  listBoards(page);
  page.fixture.notify();
  const title = () => page.container.querySelector(".workboard-page-title")?.textContent?.trim();
  await settle(() => expect(title()).toBe("All boards"));
  page.navigate("planning");
  await settle(() => expect(title()).toBe("Planning"));
});

it("saves explicit appearance clearing without sending legacy null values", async () => {
  const page = mountPage({ boardId: "planning" });
  listBoards(page, { icon: "rocket", color: "blue" });
  connect(page);
  const form = await openBoardEditor(page);
  const picker = element<HTMLElement & Parameters<ControlUiComponents["mountAppearancePicker"]>[1]>(
    form,
    "[data-test-appearance-picker]",
  );
  picker.onChange({ icon: null, color: null });
  submitForm(form);
  await settle(() =>
    expect(page.request).toHaveBeenCalledWith("workboard.boards.upsert", {
      id: "planning",
      clearAppearance: ["icon", "color"],
    }),
  );
});

it("captures the board opener before the host dialog can defer mounting", async () => {
  const page = mountPage({ connected: true });
  const opener = await settle(() =>
    element<HTMLButtonElement>(page.container, ".workboard-new-board"),
  );
  opener.focus();
  opener.click();
  await settle(() => {
    const props = vi.mocked(page.fixture.host.components.mountDialog).mock.lastCall?.[1];
    expect(props?.label).toBe("New board");
    expect(props?.returnFocusTarget).toBe(opener);
  });
});
