import "../../test/dom.setup.ts";
import { expectDefined } from "@openclaw/normalization-core";
import type {
  ControlUiAgentPickerProps,
  ControlUiComponents,
} from "openclaw/plugin-sdk/control-ui";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createGatewaySession,
  createWorkboardCard,
} from "../../lib/workboard/test/index-helpers.ts";
import { afterWorkboardUpdate } from "../../test/settle.ts";
import { fill, submitForm, query, queries } from "./view.test-support.ts";
import {
  mountPage as mountWorkboardPage,
  observeSessions,
  openBoardEditor,
  openSessionTab,
  openSessionButton,
  visibleToast,
  sessionPicker,
} from "./workboard-page.test-support.ts";

function mountPage(params?: Parameters<typeof mountWorkboardPage>[0]) {
  const page = mountWorkboardPage(params);
  return {
    ...page,
    state: page.workboard.state,
    ...queries(page.container),
    summary: page.fixture.host.components.mountSessionSummary,
    error: () => visibleToast(page.container)?.querySelector('[role="alert"]')?.textContent,
    requests: (method: string) => page.request.mock.calls.filter(([name]) => name === method),
    connect(connected = true) {
      page.fixture.connection.connected = connected;
      page.fixture.notify();
    },
  };
}

const metadataError = "Agent metadata temporarily unavailable";
type Page = ReturnType<typeof mountPage>;
function intercept(page: Page, method: string, response: () => unknown) {
  const request = expectDefined(page.request.getMockImplementation(), "request implementation");
  page.request.mockImplementation(async (name, params) =>
    name === method ? response() : request(name, params),
  );
}
function boardPage(
  appearance: { name?: string; icon?: string; color?: string } = { name: "Planning" },
) {
  const page = mountPage({ boardId: "planning" });
  intercept(page, "workboard.cards.list", () => ({
    cards: [],
    boards: [
      {
        id: "planning",
        total: 0,
        active: 0,
        archived: 0,
        byStatus: {},
        ...appearance,
      },
    ],
  }));
  return page;
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

it("loads, refreshes, and searches cards through the plugin's authenticated host", async () => {
  const page = mountPage({ connected: true });
  await afterWorkboardUpdate(() => expect(page.container.textContent).toContain("Initial card"));
  page.cards([createWorkboardCard({ title: "Updated card" })]);
  page.fixture.emit("plugin.workboard.changed", { epoch: "current", revision: 1 });
  await afterWorkboardUpdate(() => expect(page.container.textContent).toContain("Updated card"));
  expect(page.container.textContent).not.toContain("Initial card");
  page.get<HTMLButtonElement>(".workboard-search-trigger").click();
  const input = await afterWorkboardUpdate(() => {
    const current = page.get<HTMLInputElement>("#workboard-search-input");
    expect(document.activeElement).toBe(current);
    return current;
  });
  fill(input, "Updated");
  await afterWorkboardUpdate(() => {
    expect(page.state.query).toBe("Updated");
    expect(page.find(".workboard-filter-chip")?.textContent).toContain("Updated");
  });
  expect(page.find("#workboard-search-input")).toBe(input);
  expect(document.activeElement).toBe(input);
  input.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
  );
  await afterWorkboardUpdate(() =>
    expect(document.activeElement).toBe(page.get<HTMLButtonElement>(".workboard-search-trigger")),
  );
  expect(page.state.query).toBe("");
});

it("keeps writer scope recoverable after the roster shrinks to one agent", async () => {
  const scope = "writer";
  const page = mountPage();
  page.cards([
    createWorkboardCard({ id: "main-card", title: "Main agent task", agentId: "main" }),
    createWorkboardCard({ id: "writer-card", title: "Writer agent task", agentId: "writer" }),
  ]);
  page.connect();
  await afterWorkboardUpdate(() => expect(page.all(".workboard-card")).toHaveLength(2));
  page.fixture.host.agents.setScope(scope);
  page.agents([{ id: "main" }]);
  await page.fixture.host.agents.refresh();
  await afterWorkboardUpdate(() => expect(page.all(".workboard-card")).toHaveLength(1));
  expect(page.container.textContent).toContain("Writer agent task");
  const picker = page.get<HTMLElement & ControlUiAgentPickerProps>(
    ".workboard-agent-filter [data-test-agent-picker]",
  );
  expect(picker.value).toBe(scope);
  expect(picker.options).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ value: scope, label: scope }),
      expect.objectContaining({ value: "", label: "All agents" }),
    ]),
  );
  picker.onSelect("");
  await afterWorkboardUpdate(() => expect(page.all(".workboard-card")).toHaveLength(2));
  expect(page.container.textContent).toContain("Main agent task");
  expect(page.container.textContent).toContain("Writer agent task");
  expect(page.fixture.host.agents.scopeId).toBeNull();
  expect(page.find(".workboard-scope")).toBeNull();
});

it("clears filters without changing the global agent context", async () => {
  const page = mountPage();
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
  page.connect();
  await afterWorkboardUpdate(() => expect(page.all(".workboard-card")).toHaveLength(3));
  for (const priority of ["High", "Urgent"]) {
    page
      .get<HTMLInputElement>(
        `.workboard-filter-section__options[aria-label="Priority"] label[title="${priority}"] input`,
      )
      .click();
    await afterWorkboardUpdate(() =>
      expect(page.state.priorityFilter.size).toBe(priority === "High" ? 1 : 2),
    );
  }
  const picker = page.get<HTMLElement & ControlUiAgentPickerProps>(
    ".workboard-agent-filter [data-test-agent-picker]",
  );
  picker.onSelect("main");
  await afterWorkboardUpdate(() => {
    expect(page.all(".workboard-card")).toHaveLength(1);
    expect(page.find('button[aria-label="Filters, 1 active"]')).not.toBeNull();
    expect(
      page.find('.workboard-filter-chip--mobile button[aria-label="Remove filter: Agent: Molty"]'),
    ).not.toBeNull();
  });
  page.get<HTMLButtonElement>(".workboard-filter-clear").click();
  expect(page.fixture.host.agents.setScope).toHaveBeenLastCalledWith("main");
  await afterWorkboardUpdate(() => {
    expect(page.all(".workboard-card")).toHaveLength(1);
    expect(page.find(".workboard-board")?.textContent).toContain("Molty high task");
    expect(page.find(".workboard-board")?.textContent).not.toContain("Writer urgent task");
    expect(page.find(".workboard-board")?.textContent).not.toContain("Writer low task");
    expect(page.find('button[aria-label="Filters, 1 active"]')).toBeNull();
    expect(
      page.find('.workboard-filter-chip--mobile button[aria-label="Remove filter: Agent: Molty"]'),
    ).not.toBeNull();
  });
  expect(page.state.priorityFilter.size).toBe(0);
  page.get<HTMLButtonElement>('button[aria-label="Remove filter: Agent: Molty"]').click();
  expect(page.fixture.host.agents.setScope).toHaveBeenLastCalledWith(null);
  await afterWorkboardUpdate(() => {
    expect(page.all(".workboard-card")).toHaveLength(3);
    expect(page.find(".workboard-filter-chip--mobile")).toBeNull();
  });
});

it("suspends the session summary when its page is hidden and resumes on return", async () => {
  const page = mountPage();
  const session = createGatewaySession({ key: "agent:main:retained", agentId: "main" });
  observeSessions(page, { sessions: [session], hasMore: false });
  Object.assign(page.fixture.host.sessions, { rows: [session] });
  const card = createWorkboardCard({ sessionKey: session.key });
  page.cards([card]);
  page.state.detailCardId = card.id;
  page.connect();
  await openSessionTab(page);
  const summaries = () => [
    ...page.all<HTMLElement & { presented: boolean }>("[data-test-session-summary]"),
  ];
  await afterWorkboardUpdate(() =>
    expect(summaries().some((summary) => summary.presented)).toBe(true),
  );
  page.present(false);
  await afterWorkboardUpdate(() =>
    expect(summaries().some((summary) => summary.presented)).toBe(false),
  );
  page.fixture.emit("session.message", { sessionKey: session.key, agentId: "main" });
  await Promise.resolve();
  expect(summaries().some((summary) => summary.presented)).toBe(false);
  page.present(true);
  await afterWorkboardUpdate(() =>
    expect(summaries().some((summary) => summary.presented)).toBe(true),
  );
});

it("resolves an open card independently of the filtered session roster", async () => {
  const link = "subagent:workboard-default-writer";
  const key = `agent:writer:${link}`;
  const page = mountPage();
  const session = createGatewaySession({ key, agentId: "writer" });
  const primaryRows = [createGatewaySession({ key: "global", agentId: "main", kind: "global" })];
  const observe = observeSessions(page, { sessions: [session], hasMore: false });
  Object.assign(page.fixture.host.sessions, { rows: primaryRows });
  const card = createWorkboardCard({ agentId: "main", sessionKey: link });
  page.cards([card]);
  page.state.detailCardId = card.id;
  page.connect();

  await openSessionTab(page);
  await afterWorkboardUpdate(() =>
    expect(page.summary).toHaveBeenCalledWith(
      expect.any(HTMLElement),
      expect.objectContaining({ session: { sessionKey: key, agentId: "writer" } }),
    ),
  );
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
  expect(page.fixture.host.sessions.rows).toEqual(primaryRows);
  expect(page.fixture.host.sessions.refresh).not.toHaveBeenCalled();
  expectDefined(openSessionButton(page.container), "open resolved session").click();
  expect(page.fixture.host.sessions.open).toHaveBeenCalledWith({
    sessionKey: key,
    agentId: "writer",
  });
});

it("keeps a bare unknown link unresolved despite an ambient roster owner", async () => {
  const key = "unknown";
  const page = mountPage();
  const ambient = createGatewaySession({ key, kind: key, agentId: "main" });
  const exact = createGatewaySession({ key: "agent:writer:existing", agentId: "writer" });
  Object.assign(page.fixture.host.sessions, { rows: [ambient, exact] });
  const observe = observeSessions(page, { sessions: [ambient], hasMore: false });
  const card = createWorkboardCard({ agentId: "writer", sessionKey: key });
  page.cards([card]);
  page.connect();

  await afterWorkboardUpdate(() =>
    expect(page.find(".workboard-card")?.textContent).toContain("Unknown"),
  );
  expect(openSessionButton(page.container)).toBeUndefined();
  expect(page.find('button[aria-label="Stop session"]')).toBeNull();
  page.get<HTMLButtonElement>('button[aria-label="View details"]').click();
  await afterWorkboardUpdate(() =>
    expect(page.find(".workboard-detail .workboard-session-badge")?.textContent?.trim()).toBe(
      "Ambiguous",
    ),
  );
  expect(page.find(".workboard-detail__session-row")?.getAttribute("title")).toBe(
    "Edit the card to select an exact session",
  );
  expect(observe).not.toHaveBeenCalled();
  expect(page.summary).not.toHaveBeenCalled();
  expect(openSessionButton(page.container)).toBeUndefined();
  page.get<HTMLButtonElement>('.workboard-detail button[aria-label="Edit card"]').click();
  await afterWorkboardUpdate(() => expect(sessionPicker(page.container)).toBeDefined());
  const select = expectDefined(sessionPicker(page.container), "session link editor");
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
    page.state.detailCardId = card.id;
    page.connect();

    await afterWorkboardUpdate(() => {
      expect(observe).toHaveBeenCalledOnce();
      expect(page.find(".workboard-detail .workboard-session-badge")?.textContent?.trim()).toBe(
        label,
      );
    });
    expect(page.summary).not.toHaveBeenCalled();

    page.find<HTMLButtonElement>('button[aria-label="Edit card"]')!.click();
    await afterWorkboardUpdate(() => expect(sessionPicker(page.container)).toBeDefined());
    const select = expectDefined(sessionPicker(page.container), "session picker");
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
  page.state.detailCardId = first.id;
  page.connect();
  await afterWorkboardUpdate(() => expect(observe).toHaveBeenCalledOnce());

  page.state.detailCardId = second.id;
  page.workboard.notify();
  await openSessionTab(page);
  await afterWorkboardUpdate(() =>
    expect(page.summary).toHaveBeenCalledWith(
      expect.any(HTMLElement),
      expect.objectContaining({ session: { sessionKey: `agent:writer:${secondKey}` } }),
    ),
  );
  expect(page.summary).not.toHaveBeenCalledWith(
    expect.any(HTMLElement),
    expect.objectContaining({ session: { sessionKey: `agent:main:${firstKey}` } }),
  );
  expect(observe).toHaveBeenCalledTimes(2);
  expect(releaseFirst).toHaveBeenCalledOnce();
});

it("keeps failed metadata visible through card refreshes and recovers it with page Refresh", async () => {
  const page = mountPage();
  page.agents([{ id: "main", name: "Configured operator" }]);
  page.cards([createWorkboardCard({ title: "Initial card", agentId: "main" })]);
  const metadata = createDeferred<unknown>();
  const request = expectDefined(page.request.getMockImplementation(), "request implementation");
  let metadataAvailable = false;
  page.request.mockImplementation((method) =>
    method === "agents.list" && !metadataAvailable ? metadata.promise : request(method),
  );
  page.connect();
  await afterWorkboardUpdate(() => expect(page.container.textContent).toContain("Initial card"));
  metadata.reject(new Error(metadataError));
  await afterWorkboardUpdate(() =>
    expect(visibleToast(page.container)?.textContent).toContain(metadataError),
  );

  page.cards([createWorkboardCard({ title: "Updated card", agentId: "main" })]);
  page.fixture.emit("plugin.workboard.changed", { epoch: "current", revision: 1 });
  await afterWorkboardUpdate(() => expect(page.container.textContent).toContain("Updated card"));
  expect(visibleToast(page.container)?.textContent).toContain(metadataError);
  expect(page.find('.workboard-card [role="img"][aria-label="Configured operator"]')).toBeNull();
  expect(page.requests("agents.list")).toHaveLength(1);

  metadataAvailable = true;
  page.find<HTMLButtonElement>('button[aria-label="Refresh"]')!.click();
  await afterWorkboardUpdate(() =>
    expect(
      page.find('.workboard-card [role="img"][aria-label="Configured operator"]'),
    ).not.toBeNull(),
  );
  expect(visibleToast(page.container)?.textContent ?? "").not.toContain(metadataError);
  expect(page.container.textContent).toContain("Updated card");
  expect(page.requests("agents.list")).toHaveLength(2);
});

it("shows independent metadata and linked-session failures together", async () => {
  const page = mountPage();
  const card = createWorkboardCard({ sessionKey: "agent:main:unavailable-session" });
  page.cards([card]);
  page.state.detailCardId = card.id;
  intercept(page, "agents.list", () => Promise.reject(new Error(metadataError)));
  vi.mocked(page.fixture.host.sessions.observe).mockImplementation((_query, listener) => {
    listener({ result: null, loading: false, error: "Linked session temporarily unavailable" });
    return { refresh: vi.fn(async () => undefined), dispose: vi.fn() };
  });
  page.connect();

  await afterWorkboardUpdate(() => {
    const message = page.error();
    expect(message).toContain(metadataError);
    expect(message).toContain("Linked session temporarily unavailable");
  });
});

it("keeps page failures visible in the board editor and prioritizes its save failure", async () => {
  const page = boardPage({});
  intercept(page, "agents.list", () => {
    throw new Error(metadataError);
  });
  intercept(page, "workboard.boards.upsert", () => {
    throw new Error("Board update denied");
  });
  page.connect();
  const form = await openBoardEditor(page);
  await afterWorkboardUpdate(() => {
    expect(page.error()).toBe(metadataError);
  });
  submitForm(form);
  await afterWorkboardUpdate(() => {
    expect(page.error()).toBe("Board update denied");
  });
});

it.each(["canWrite", "connected"] as const)(
  "preserves a board draft without saving when %s is revoked",
  async (capability) => {
    const page = boardPage();
    page.connect();
    const form = await openBoardEditor(page);
    const name = query<HTMLInputElement>(form, "input");
    name.value = "Release planning";
    name.dispatchEvent(new Event("input", { bubbles: true }));
    page.fixture.connection[capability] = false;
    submitForm(form);
    expect(page.requests("workboard.boards.upsert")).toHaveLength(0);
    page.fixture.notify();
    await afterWorkboardUpdate(() =>
      expect(form.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(true),
    );
    expect(name.value).toBe("Release planning");
    page.fixture.connection[capability] = true;
    page.fixture.notify();
    await afterWorkboardUpdate(() =>
      expect(form.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(false),
    );
    submitForm(form);
    await afterWorkboardUpdate(() => {
      expect(page.request).toHaveBeenCalledWith("workboard.boards.upsert", {
        id: "planning",
        name: "Release planning",
      });
      expect(page.find(".workboard-board-draft")).toBeNull();
    });
  },
);

it("requires a canonical refresh after reconnect before mutations resume", async () => {
  const page = mountPage({ connected: true });
  await afterWorkboardUpdate(() => expect(page.state.loaded).toBe(true));
  page.connect(false);
  expect(page.state.mutationReadiness).toBe("canonical_reload_required");
  page.cards([createWorkboardCard({ title: "Reconnected card" })]);
  page.connect();
  await afterWorkboardUpdate(() =>
    expect(page.container.textContent).toContain("Reconnected card"),
  );
  expect(page.state.mutationReadiness).toBe("ready");
});

it("releases listeners and stops refreshes when its mount is disposed", async () => {
  const page = mountPage({ connected: true });
  await afterWorkboardUpdate(() => expect(page.state.loaded).toBe(true));
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
      const card = createWorkboardCard({
        title: "Original task",
        notes: "Original notes",
        agentId: "writer",
        metadata: { automation: { boardId: "ops" } },
      });
      page.cards([card]);
      page.fixture.host.agents.setScope("writer");
      page.connect();
      await afterWorkboardUpdate(() => expect(page.state.loaded).toBe(true));
      page.get<HTMLButtonElement>('button[aria-label="View details"]').click();
      await afterWorkboardUpdate(() => expect(page.find(".workboard-detail")).not.toBeNull());
      page.get<HTMLButtonElement>('.workboard-detail button[aria-label="Edit card"]').click();
      await afterWorkboardUpdate(() => expect(page.find(".workboard-draft")).not.toBeNull());
      const form = () => page.get<HTMLFormElement>(".workboard-draft");
      const title = query<HTMLInputElement>(form(), ".workboard-draft__title");
      const notes = query<HTMLTextAreaElement>(form(), ".workboard-draft__notes");
      const values = () => ({
        title: form().querySelector<HTMLInputElement>(".workboard-draft__title")?.value,
        notes: form().querySelector<HTMLTextAreaElement>(".workboard-draft__notes")?.value,
      });
      const submitted = { title: "Submitted task", notes: "Keep these unsaved notes" };
      fill(title, submitted.title);
      fill(notes, submitted.notes);
      const pending = createDeferred<unknown>();
      let updateResult = pending.promise;
      const request = expectDefined(page.request.getMockImplementation(), "host request");
      page.request.mockImplementation((method) =>
        method === "workboard.cards.update" ? updateResult : request(method),
      );
      submitForm(form());
      await afterWorkboardUpdate(() =>
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
      const pendingDraft = {
        ...values(),
        busy: form().getAttribute("aria-busy"),
        enabled: form().querySelectorAll(
          "input:enabled, textarea:enabled, select:enabled, button:enabled",
        ).length,
      };
      pending.reject(new Error("Save unavailable; retry this edit."));
      await afterWorkboardUpdate(() => {
        expect(page.state.draftSaving).toBe(false);
        expect(page.error()).toBe("Save unavailable; retry this edit.");
      });

      expect(pendingDraft).toEqual({ ...submitted, busy: "true", enabled: 0 });
      const toast = expectDefined(visibleToast(page.container), "retry guidance");
      expect(toast.closest('[inert], [aria-hidden="true"]')).toBeNull();
      expect(toast.closest("[data-test-dialog]")).toBe(form().closest("[data-test-dialog]"));
      expect(values()).toEqual(submitted);
      const saved = { ...card, title: title.value, notes: notes.value, updatedAt: 2 };
      updateResult = Promise.resolve({ card: saved });
      submitForm(form());
      await afterWorkboardUpdate(() => expect(page.state.draftOpen).toBe(false));
      expect(page.requests("workboard.cards.update")).toHaveLength(2);
      expect(page.state.cards.find((entry) => entry.id === card.id)).toMatchObject(saved);
      expect(page.find(".workboard-draft, .workboard-detail")).toBeNull();
      const main = page.get(".workboard-main");
      expect(main.textContent).not.toContain(saved.title);
    },
  );

  it("keeps a default-agent card's detail and draft when selecting its scope without metadata", async () => {
    const page = mountPage();
    const card = createWorkboardCard({ title: "Default-agent card" });
    page.cards([card]);
    page.fixture.connection.assistantAgentId = "research";
    vi.mocked(page.fixture.host.agents.refresh).mockRejectedValue(
      new Error("Agent metadata unavailable"),
    );
    page.connect();
    await afterWorkboardUpdate(() =>
      expect(page.find(".workboard-card")?.textContent).toContain(card.title),
    );
    page.find<HTMLButtonElement>('button[aria-label="View details"]')!.click();
    await afterWorkboardUpdate(() => expect(page.find(".workboard-detail")).not.toBeNull());
    const selector = ".workboard-detail__note";
    const input = page.find<HTMLInputElement | HTMLTextAreaElement>(selector)!;
    fill(input, "Keep this draft");
    expect(page.fixture.host.agents.defaultId).toBeNull();
    page.fixture.host.agents.setScope("research");
    await Promise.resolve();

    expect(page.find<HTMLInputElement | HTMLTextAreaElement>(selector)?.value).toBe(
      "Keep this draft",
    );
    expect(page.find(".workboard-board")?.textContent).toContain(card.title);
    expect(page.fixture.host.agents.scopeId).toBe("research");
  });

  it("dismisses overlays outside main scope", async () => {
    const page = mountPage();
    page.state.cards = [createWorkboardCard({ id: "writer-card", agentId: "writer" })];
    page.fixture.host.agents.setScope("writer");
    await Promise.resolve();
    Object.assign(page.state, {
      detailCardId: "writer-card",
      detailCommentBody: "Draft comment",
      draftOpen: true,
      editingCardId: "writer-card",
    });
    page.fixture.host.agents.setScope("main");
    await Promise.resolve();
    expect(page.state).toMatchObject({
      detailCardId: null,
      detailCommentBody: "",
      draftOpen: false,
    });
  });

  it("preserves a new-card draft across board navigation", async () => {
    const page = mountPage({ boardId: "ops" });
    Object.assign(page.state, { draftOpen: true, draftTitle: "New operations task" });
    page.navigate("product");
    await Promise.resolve();
    expect(page.state.draftOpen).toBe(true);
    expect(page.state.draftTitle).toBe("New operations task");
  });
});

it("saves explicit appearance clearing without sending legacy null values", async () => {
  const page = boardPage({ name: "Planning", icon: "rocket", color: "blue" });
  page.connect();
  const form = await openBoardEditor(page);
  const picker = query<HTMLElement & Parameters<ControlUiComponents["mountAppearancePicker"]>[1]>(
    form,
    "[data-test-appearance-picker]",
  );
  picker.onChange({ icon: null, color: null });
  submitForm(form);
  await afterWorkboardUpdate(() =>
    expect(page.request).toHaveBeenCalledWith("workboard.boards.upsert", {
      id: "planning",
      clearAppearance: ["icon", "color"],
    }),
  );
});
