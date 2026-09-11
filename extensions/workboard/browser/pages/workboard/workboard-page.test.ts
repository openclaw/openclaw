import "../../test/dom.setup.ts";
import { expectDefined } from "@openclaw/normalization-core";
import type {
  ControlUiAgentPickerProps,
  ControlUiComponents,
  ControlUiSessionListResult,
} from "openclaw/plugin-sdk/control-ui";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentsListResult } from "../../api/types.ts";
import { createWorkboardCapability } from "../../lib/workboard/capability.ts";
import {
  createGatewaySession,
  createWorkboardCard,
} from "../../lib/workboard/test/index-helpers.ts";
import { workboardTestHost } from "../../test/host.setup.ts";
import { createViewContext } from "../../test/host.ts";
import { createWorkboardPage } from "./workboard-page.ts";

type ControlUiSelectPickerProps = Parameters<ControlUiComponents["mountSelectPicker"]>[1];

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const dispose of cleanup.splice(0).toReversed()) {
    dispose();
  }
  document.body.replaceChildren();
});

function mountPage(params: { boardId?: string; connected?: boolean; presented?: boolean } = {}) {
  const fixture = workboardTestHost();
  const workboard = createWorkboardCapability();
  fixture.connection.connected = params.connected ?? false;
  Object.assign(fixture.host.agents, { rows: [], defaultId: null });
  let agents: AgentsListResult["agents"] = [{ id: "main" }, { id: "writer" }];
  let cards = [createWorkboardCard({ title: "Initial card" })];
  const request = vi.fn(async (method: string, _params?: unknown): Promise<unknown> => {
    if (method === "agents.list") {
      return {
        defaultId: "main",
        mainKey: "main",
        scope: "per-sender",
        agents: [...agents],
      };
    }
    if (method === "workboard.cards.list") {
      return { cards };
    }
    if (method === "tasks.list") {
      return { tasks: [] };
    }
    return {};
  });
  fixture.host.request = request as typeof fixture.host.request;
  fixture.host.agents.refresh = vi.fn(async () => {
    const result = await fixture.host.request<AgentsListResult>("agents.list", {});
    Object.assign(fixture.host.agents, { rows: result.agents, defaultId: result.defaultId });
    fixture.notify();
  });
  const container = document.createElement("div");
  document.body.append(container);
  let context = createViewContext<Readonly<Record<string, string>>>(
    fixture.host,
    params.boardId ? { boardId: params.boardId } : {},
    params.presented ?? true,
  );
  const mounted = createWorkboardPage(workboard)(container, context);
  cleanup.push(() => {
    mounted?.dispose?.();
    workboard.dispose();
  });
  return {
    fixture,
    workboard,
    container,
    request,
    cards(next: typeof cards) {
      cards = next;
    },
    agents(next: typeof agents) {
      agents = next;
    },
    navigate(boardId: string) {
      context = { ...context, props: { boardId } };
      mounted?.update?.(context);
    },
    present(presented: boolean) {
      context = { ...context, presented };
      mounted?.update?.(context);
    },
    dispose() {
      mounted?.dispose?.();
    },
  };
}

function visibleToast(container: Element) {
  return container.querySelector<HTMLElement>("openclaw-workboard-toast:not([hidden])");
}

function sessionPicker(container: Element) {
  type SelectProps = Parameters<ControlUiComponents["mountSelectPicker"]>[1];
  return [
    ...container.querySelectorAll<HTMLElement & SelectProps>(
      ".workboard-draft [data-test-select-picker]",
    ),
  ].find((picker) => picker.accessibleLabel === "Session");
}

function observeSessions(page: ReturnType<typeof mountPage>, result: ControlUiSessionListResult) {
  return vi.mocked(page.fixture.host.sessions.observe).mockImplementation((_query, listener) => {
    listener({ result, loading: false, error: null });
    return { refresh: vi.fn(async () => undefined), dispose: vi.fn() };
  });
}

it("loads and refreshes cards through the plugin's authenticated host", async () => {
  const page = mountPage({ connected: true });
  await vi.waitFor(() => expect(page.container.textContent).toContain("Initial card"));
  page.cards([createWorkboardCard({ title: "Updated card" })]);
  page.fixture.emit("plugin.workboard.changed", { epoch: "current", revision: 1 });
  await vi.waitFor(() => expect(page.container.textContent).toContain("Updated card"));
  expect(page.container.textContent).not.toContain("Initial card");
});

it("keeps a historical scope recoverable after the roster shrinks to one agent", async () => {
  const page = mountPage({ connected: true });
  await vi.waitFor(() => expect(page.container.textContent).toContain("Initial card"));
  page.fixture.host.agents.setScope("writer");
  page.agents([{ id: "main" }]);
  await page.fixture.host.agents.refresh();
  await vi.waitFor(() => expect(page.container.textContent).not.toContain("Initial card"));
  const picker = expectDefined(
    page.container.querySelector<HTMLElement & ControlUiAgentPickerProps>(
      ".workboard-scope [data-test-agent-picker]",
    ),
    "historical scope picker",
  );
  expect(picker.value).toBe("writer");
  expect(picker.options).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ value: "writer", label: "writer" }),
      expect.objectContaining({ value: "", label: "All agents" }),
    ]),
  );
  picker.onSelect("");
  await vi.waitFor(() => expect(page.container.textContent).toContain("Initial card"));
  expect(page.fixture.host.agents.scopeId).toBeNull();
  expect(page.container.querySelector(".workboard-scope")).toBeNull();
});

it.each([false, true])(
  "offers global agent scope only for multiple selectable agents: %s",
  async (multiple) => {
    const page = mountPage();
    page.agents([
      { id: "main" },
      ...(multiple ? [{ id: "writer" }] : []),
      { id: "system", kind: "system" },
    ]);
    page.cards([
      createWorkboardCard({ id: "main-card", title: "Main agent task", agentId: "main" }),
      createWorkboardCard({ id: "writer-card", title: "Writer agent task", agentId: "writer" }),
    ]);
    page.fixture.connection.connected = true;
    page.fixture.notify();
    await vi.waitFor(() => expect(page.fixture.host.agents.rows).toHaveLength(multiple ? 3 : 2));
    await vi.waitFor(() =>
      expect(page.container.querySelectorAll(".workboard-card")).toHaveLength(2),
    );
    const pickers = page.container.querySelectorAll<HTMLElement & ControlUiAgentPickerProps>(
      "[data-test-agent-picker]",
    );
    expect(pickers).toHaveLength(multiple ? 1 : 0);
    expect(
      [
        ...page.container.querySelectorAll<HTMLElement & ControlUiSelectPickerProps>(
          "[data-test-select-picker]",
        ),
      ].some((picker) => picker.accessibleLabel === "Agent"),
    ).toBe(false);
    if (!multiple) {
      return;
    }
    const picker = expectDefined(pickers[0], "global scope picker");
    expect(picker.closest(".workboard-agent-filter")).not.toBeNull();
    expect(picker.options.map((option) => option.value)).toEqual(["", "main", "writer"]);
    picker.onSelect("writer");
    expect(page.fixture.host.agents.setScope).toHaveBeenCalledWith("writer");
    await vi.waitFor(() => {
      expect(page.container.querySelectorAll(".workboard-card")).toHaveLength(1);
      expect(page.container.querySelector(".workboard-card")?.textContent).toContain(
        "Writer agent task",
      );
      expect(page.container.querySelector('button[aria-label="Filters, 1 active"]')).toBeNull();
      expect(page.container.querySelector(".workboard-filter-chip")).toBeNull();
    });
    picker.onSelect("");
    expect(page.fixture.host.agents.setScope).toHaveBeenLastCalledWith(null);
    await vi.waitFor(() => {
      expect(page.container.querySelectorAll(".workboard-card")).toHaveLength(2);
      expect(page.container.querySelector('button[aria-label="Filters, 1 active"]')).toBeNull();
    });
  },
);

it("clears filters without changing the global agent context", async () => {
  const page = mountPage();
  page.agents([
    { id: "main", name: "Molty" },
    { id: "writer", name: "Writer" },
  ]);
  page.cards([
    createWorkboardCard({
      id: "main-high",
      title: "Molty high task",
      agentId: "main",
      priority: "high",
    }),
    createWorkboardCard({
      id: "writer-urgent",
      title: "Writer urgent task",
      agentId: "writer",
      priority: "urgent",
    }),
    createWorkboardCard({
      id: "writer-low",
      title: "Writer low task",
      agentId: "writer",
      priority: "low",
    }),
  ]);
  page.fixture.connection.connected = true;
  page.fixture.notify();
  await vi.waitFor(() =>
    expect(page.container.querySelectorAll(".workboard-card")).toHaveLength(3),
  );
  for (const priority of ["High", "Urgent"]) {
    expectDefined(
      page.container.querySelector<HTMLInputElement>(
        `.workboard-filter-section__options[aria-label="Priority"] label[title="${priority}"] input`,
      ),
      `${priority} priority filter`,
    ).click();
    await vi.waitFor(() =>
      expect(page.workboard.state.priorityFilter.size).toBe(priority === "High" ? 1 : 2),
    );
  }
  const picker = expectDefined(
    page.container.querySelector<HTMLElement & ControlUiAgentPickerProps>(
      ".workboard-agent-filter [data-test-agent-picker]",
    ),
    "global agent filter",
  );
  picker.onSelect("main");
  await vi.waitFor(() => {
    expect(page.container.querySelectorAll(".workboard-card")).toHaveLength(1);
    expect(page.container.querySelector('button[aria-label="Filters, 1 active"]')).not.toBeNull();
    expect(
      page.container.querySelector('button[aria-label="Remove filter: Agent: Molty"]'),
    ).toBeNull();
  });
  expectDefined(
    page.container.querySelector<HTMLButtonElement>(".workboard-filter-clear"),
    "clear filters",
  ).click();
  expect(page.fixture.host.agents.setScope).toHaveBeenLastCalledWith("main");
  await vi.waitFor(() => {
    expect(page.container.querySelectorAll(".workboard-card")).toHaveLength(1);
    expect(page.container.querySelector(".workboard-board")?.textContent).toContain(
      "Molty high task",
    );
    expect(page.container.querySelector(".workboard-board")?.textContent).not.toContain(
      "Writer urgent task",
    );
    expect(page.container.querySelector(".workboard-board")?.textContent).not.toContain(
      "Writer low task",
    );
    expect(page.container.querySelector('button[aria-label="Filters, 1 active"]')).toBeNull();
    expect(
      page.container.querySelector('button[aria-label="Remove filter: Agent: Molty"]'),
    ).toBeNull();
  });
  expect(page.workboard.state.priorityFilter.size).toBe(0);
  picker.onSelect("");
  await vi.waitFor(() =>
    expect(page.container.querySelectorAll(".workboard-card")).toHaveLength(3),
  );
});

it.each([
  {
    link: "subagent:workboard-default-writer",
    key: "agent:writer:subagent:workboard-default-writer",
  },
  { link: "agent:writer:existing", key: "agent:writer:existing" },
])(
  "resolves an open $link card independently of the filtered session roster",
  async ({ link, key }) => {
    const page = mountPage();
    const session = createGatewaySession({ key, agentId: "writer" });
    const primaryRows = [createGatewaySession({ key: "global", agentId: "main", kind: "global" })];
    const observe = observeSessions(page, { sessions: [session], hasMore: false });
    Object.assign(page.fixture.host.sessions, { rows: primaryRows });
    const card = createWorkboardCard({ agentId: "main", sessionKey: link });
    page.cards([card]);
    page.workboard.state.detailCardId = card.id;
    page.fixture.connection.connected = true;
    page.fixture.notify();

    await vi.waitFor(() =>
      expect(page.fixture.host.components.mountDashboard).toHaveBeenCalledWith(
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
    page.container.querySelector<HTMLButtonElement>('button[aria-label="Open session"]')!.click();
    expect(page.fixture.host.sessions.open).toHaveBeenCalledWith({
      sessionKey: key,
      agentId: "writer",
    });
  },
);

it.each(["global", "unknown"] as const)(
  "keeps a bare %s link unresolved despite an ambient roster owner",
  async (key) => {
    const page = mountPage();
    const ambient = createGatewaySession({ key, kind: key, agentId: "main" });
    const exact = createGatewaySession({ key: "agent:writer:existing", agentId: "writer" });
    Object.assign(page.fixture.host.sessions, { rows: [ambient, exact] });
    const observe = observeSessions(page, { sessions: [ambient], hasMore: false });
    const card = createWorkboardCard({ agentId: "writer", sessionKey: key });
    page.cards([card]);
    page.fixture.connection.connected = true;
    page.fixture.notify();

    await vi.waitFor(() =>
      expect(page.container.querySelector(".workboard-card")?.textContent).toContain("Unknown"),
    );
    expect(page.container.querySelector('button[aria-label="Open session"]')).toBeNull();
    expect(page.container.querySelector('button[aria-label="Stop session"]')).toBeNull();
    expectDefined(
      page.container.querySelector<HTMLButtonElement>('button[aria-label="View details"]'),
      "open unresolved card details",
    ).click();
    await vi.waitFor(() =>
      expect(page.container.querySelector(".workboard-detail")?.textContent).toContain(
        "Session link ambiguous",
      ),
    );
    expect(page.container.querySelector(".workboard-detail")?.textContent).toContain(
      "Edit the card to select an exact session",
    );
    expect(observe).not.toHaveBeenCalled();
    expect(page.fixture.host.components.mountDashboard).not.toHaveBeenCalled();
    expect(page.container.querySelector('button[aria-label="Open session"]')).toBeNull();
    expectDefined(
      page.container.querySelector<HTMLButtonElement>(
        '.workboard-detail button[aria-label="Edit card"]',
      ),
      "recover the unresolved link",
    ).click();
    await vi.waitFor(() => expect(sessionPicker(page.container)).toBeDefined());
    const select = expectDefined(sessionPicker(page.container), "session link editor");
    expect(select.value).toBe(key);
    expect(select.options.map((option) => option.value)).toContain(exact.key);
  },
);

it.each([
  {
    name: "incomplete",
    owners: ["writer"],
    hasMore: true,
    totalCount: 2,
    label: "Session state unknown",
  },
  {
    name: "deletion-filtered",
    owners: ["writer"],
    hasMore: false,
    totalCount: 2,
    label: "Session state unknown",
  },
  {
    name: "ambiguous",
    owners: ["writer", "other"],
    hasMore: false,
    totalCount: 2,
    label: "Session link ambiguous",
  },
  { name: "empty", owners: [], hasMore: false, totalCount: 0, label: "Session unavailable" },
])(
  "keeps an $name linked-session query unresolved",
  async ({ owners, hasMore, totalCount, label }) => {
    const page = mountPage();
    const localKey = "subagent:workboard-default-unresolved";
    const observe = observeSessions(page, {
      sessions: owners.map((owner) => createGatewaySession({ key: `agent:${owner}:${localKey}` })),
      hasMore,
      totalCount,
    });
    Object.assign(page.fixture.host.sessions, {
      rows: [createGatewaySession({ key: "agent:main:unrelated" })],
    });
    const card = createWorkboardCard({ sessionKey: localKey });
    page.cards([card]);
    page.workboard.state.detailCardId = card.id;
    page.fixture.connection.connected = true;
    page.fixture.notify();

    await vi.waitFor(() => expect(observe).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(page.container.textContent).toContain(label));
    expect(page.fixture.host.components.mountDashboard).not.toHaveBeenCalled();

    page.container.querySelector<HTMLButtonElement>('button[aria-label="Edit card"]')!.click();
    await vi.waitFor(() => expect(sessionPicker(page.container)).toBeDefined());
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
  page.workboard.state.detailCardId = first.id;
  page.fixture.connection.connected = true;
  page.fixture.notify();
  await vi.waitFor(() => expect(observe).toHaveBeenCalledOnce());

  page.workboard.state.detailCardId = second.id;
  page.workboard.notify();
  await vi.waitFor(() =>
    expect(page.fixture.host.components.mountDashboard).toHaveBeenCalledWith(
      expect.any(HTMLElement),
      expect.objectContaining({ session: { sessionKey: `agent:writer:${secondKey}` } }),
    ),
  );
  expect(page.fixture.host.components.mountDashboard).not.toHaveBeenCalledWith(
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
  page.fixture.connection.connected = true;
  page.fixture.notify();
  await vi.waitFor(() => expect(page.container.textContent).toContain("Initial card"));
  metadata.reject(new Error("Agent metadata temporarily unavailable"));
  await vi.waitFor(() =>
    expect(visibleToast(page.container)?.shadowRoot?.textContent).toContain(
      "Agent metadata temporarily unavailable",
    ),
  );

  page.cards([createWorkboardCard({ title: "Updated card", agentId: "main" })]);
  page.fixture.emit("plugin.workboard.changed", { epoch: "current", revision: 1 });
  await vi.waitFor(() => expect(page.container.textContent).toContain("Updated card"));
  expect(visibleToast(page.container)?.shadowRoot?.textContent).toContain(
    "Agent metadata temporarily unavailable",
  );
  expect(
    page.container.querySelector('.workboard-card [role="img"][aria-label="Configured operator"]'),
  ).toBeNull();
  expect(page.request.mock.calls.filter(([method]) => method === "agents.list")).toHaveLength(1);

  metadataAvailable = true;
  page.container.querySelector<HTMLButtonElement>('button[aria-label="Refresh"]')!.click();
  await vi.waitFor(() =>
    expect(
      page.container.querySelector(
        '.workboard-card [role="img"][aria-label="Configured operator"]',
      ),
    ).not.toBeNull(),
  );
  expect(visibleToast(page.container)?.shadowRoot?.textContent ?? "").not.toContain(
    "Agent metadata temporarily unavailable",
  );
  expect(page.container.textContent).toContain("Updated card");
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
  page.fixture.connection.connected = true;
  page.fixture.notify();

  await vi.waitFor(() => {
    const message = page.container.querySelector('.workboard-detail [role="alert"]')?.textContent;
    expect(message).toContain("Agent metadata temporarily unavailable");
    expect(message).toContain("Linked session temporarily unavailable");
  });
});

it("requires a canonical refresh after reconnect before mutations resume", async () => {
  const page = mountPage({ connected: true });
  await vi.waitFor(() => expect(page.workboard.state.loaded).toBe(true));
  page.fixture.connection.connected = false;
  page.fixture.notify();
  expect(page.workboard.state.mutationReadiness).toBe("canonical_reload_required");
  page.cards([createWorkboardCard({ title: "Reconnected card" })]);
  page.fixture.connection.connected = true;
  page.fixture.notify();
  await vi.waitFor(() => expect(page.container.textContent).toContain("Reconnected card"));
  expect(page.workboard.state.mutationReadiness).toBe("ready");
});

it("releases listeners and stops refreshes when its mount is disposed", async () => {
  const page = mountPage({ connected: true });
  await vi.waitFor(() => expect(page.workboard.state.loaded).toBe(true));
  page.dispose();
  const count = page.request.mock.calls.length;
  page.fixture.emit("plugin.workboard.changed", { epoch: "current", revision: 9 });
  page.fixture.notify();
  await Promise.resolve();
  expect(page.request).toHaveBeenCalledTimes(count);
  expect(page.fixture.listeners.size).toBe(0);
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
      page.fixture.connection.connected = true;
      page.fixture.notify();
      await vi.waitFor(() => expect(page.workboard.state.loaded).toBe(true));
      expectDefined(
        page.container.querySelector<HTMLButtonElement>('button[aria-label="View details"]'),
        "open task details",
      ).click();
      await vi.waitFor(() =>
        expect(page.container.querySelector(".workboard-detail")).not.toBeNull(),
      );
      expectDefined(
        page.container.querySelector<HTMLButtonElement>(
          '.workboard-detail button[aria-label="Edit card"]',
        ),
        "edit the selected task",
      ).click();
      await vi.waitFor(() =>
        expect(page.container.querySelector(".workboard-draft")).not.toBeNull(),
      );
      const form = () =>
        expectDefined(
          page.container.querySelector<HTMLFormElement>(".workboard-draft"),
          "card editor",
        );
      const title = expectDefined(
        form().querySelector<HTMLInputElement>(".workboard-draft__title"),
        "draft title",
      );
      const notes = expectDefined(
        form().querySelector<HTMLTextAreaElement>(".workboard-draft__notes"),
        "draft notes",
      );
      title.value = "Submitted task";
      title.dispatchEvent(new InputEvent("input", { bubbles: true }));
      notes.value = "Keep these unsaved notes";
      notes.dispatchEvent(new InputEvent("input", { bubbles: true }));
      const pending = createDeferred<unknown>();
      let updateResult = pending.promise;
      const request = expectDefined(page.request.getMockImplementation(), "host request");
      page.request.mockImplementation((method) =>
        method === "workboard.cards.update" ? updateResult : request(method),
      );
      form().dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await vi.waitFor(() =>
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
        page.container.querySelector<HTMLInputElement>(".workboard-draft__title")?.value;
      const pendingNotes =
        page.container.querySelector<HTMLTextAreaElement>(".workboard-draft__notes")?.value;
      const pendingBusy = form().getAttribute("aria-busy");
      const enabledControls = [
        ...form().querySelectorAll(
          "input:enabled, textarea:enabled, select:enabled, button:enabled",
        ),
      ];
      pending.reject(new Error("Save unavailable; retry this edit."));
      await vi.waitFor(() => expect(page.workboard.state.draftSaving).toBe(false));

      expect(pendingTitle).toBe("Submitted task");
      expect(pendingNotes).toBe("Keep these unsaved notes");
      expect(pendingBusy).toBe("true");
      expect(enabledControls).toHaveLength(0);
      await vi.waitFor(() =>
        expect(
          visibleToast(page.container)?.shadowRoot?.querySelector('[role="alert"]')?.textContent,
        ).toBe("Save unavailable; retry this edit."),
      );
      const toast = expectDefined(visibleToast(page.container), "retry guidance");
      expect(toast.closest('[inert], [aria-hidden="true"]')).toBeNull();
      expect(form().querySelector<HTMLInputElement>(".workboard-draft__title")?.value).toBe(
        "Submitted task",
      );
      expect(form().querySelector<HTMLTextAreaElement>(".workboard-draft__notes")?.value).toBe(
        "Keep these unsaved notes",
      );
      const saved = { ...card, title: title.value, notes: notes.value, updatedAt: 2 };
      updateResult = Promise.resolve({ card: saved });
      form().dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await vi.waitFor(() => expect(page.workboard.state.draftOpen).toBe(false));
      expect(
        page.request.mock.calls.filter(([method]) => method === "workboard.cards.update"),
      ).toHaveLength(2);
      expect(page.workboard.state.cards.find((entry) => entry.id === card.id)).toMatchObject(saved);
      expect(page.container.querySelector(".workboard-draft, .workboard-detail")).toBeNull();
      const main = expectDefined(
        page.container.querySelector(".workboard-main"),
        "filtered board content",
      );
      expect(main.textContent).not.toContain(saved.title);
    },
  );

  it.each(["detail", "editor"])(
    "keeps a default-agent card's %s and draft when selecting its scope without metadata",
    async (surface) => {
      const page = mountPage();
      const card = createWorkboardCard({ title: "Default-agent card" });
      page.cards([card]);
      page.fixture.connection.assistantAgentId = "research";
      vi.mocked(page.fixture.host.agents.refresh).mockRejectedValue(
        new Error("Agent metadata unavailable"),
      );
      page.fixture.connection.connected = true;
      page.fixture.notify();
      await vi.waitFor(() =>
        expect(page.container.querySelector(".workboard-card")?.textContent).toContain(card.title),
      );
      page.container.querySelector<HTMLButtonElement>('button[aria-label="View details"]')!.click();
      await vi.waitFor(() =>
        expect(page.container.querySelector(".workboard-detail")).not.toBeNull(),
      );
      if (surface === "editor") {
        page.container
          .querySelector<HTMLButtonElement>('.workboard-detail button[aria-label="Edit card"]')!
          .click();
        await vi.waitFor(() =>
          expect(page.container.querySelector(".workboard-draft")).not.toBeNull(),
        );
      }
      const selector = surface === "editor" ? ".workboard-draft__title" : ".workboard-detail__note";
      const input = page.container.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector)!;
      input.value = "Keep this draft";
      input.dispatchEvent(new InputEvent("input", { bubbles: true }));
      expect(page.fixture.host.agents.defaultId).toBeNull();
      page.fixture.host.agents.setScope("research");
      await Promise.resolve();

      expect(
        page.container.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector)?.value,
      ).toBe("Keep this draft");
      expect(page.container.querySelector(".workboard-board")?.textContent).toContain(card.title);
      expect(page.fixture.host.agents.scopeId).toBe("research");
    },
  );

  it.each([
    { scope: "main", visible: false },
    { scope: null, visible: true },
  ])("keeps only overlays inside scope $scope", async ({ scope, visible }) => {
    const page = mountPage();
    page.workboard.state.cards = [createWorkboardCard({ id: "writer-card", agentId: "writer" })];
    page.fixture.host.agents.setScope("writer");
    await Promise.resolve();
    Object.assign(page.workboard.state, {
      detailCardId: "writer-card",
      detailCommentBody: "Draft comment",
      draftOpen: true,
      editingCardId: "writer-card",
    });
    page.fixture.host.agents.setScope(scope);
    await Promise.resolve();
    expect(page.workboard.state.detailCardId).toBe(visible ? "writer-card" : null);
    expect(page.workboard.state.detailCommentBody).toBe(visible ? "Draft comment" : "");
    expect(page.workboard.state.draftOpen).toBe(visible);
  });

  it.each([
    { boardId: "product", visible: false },
    { boardId: "__all__", visible: true },
  ])("reconciles overlays when navigating to $boardId", async ({ boardId, visible }) => {
    const page = mountPage({ boardId: "ops" });
    page.workboard.state.cards = [
      createWorkboardCard({ id: "ops-card", metadata: { automation: { boardId: "ops" } } }),
    ];
    Object.assign(page.workboard.state, {
      detailCardId: "ops-card",
      detailCommentBody: "Draft comment",
      draftOpen: true,
      editingCardId: "ops-card",
    });
    page.navigate(boardId);
    await Promise.resolve();
    expect(page.workboard.state.boardFilter).toBe(boardId);
    expect(page.workboard.state.detailCardId).toBe(visible ? "ops-card" : null);
    expect(page.workboard.state.draftOpen).toBe(visible);
  });

  it("preserves a new-card draft across board navigation", async () => {
    const page = mountPage({ boardId: "ops" });
    Object.assign(page.workboard.state, { draftOpen: true, draftTitle: "New operations task" });
    page.navigate("product");
    await Promise.resolve();
    expect(page.workboard.state.draftOpen).toBe(true);
    expect(page.workboard.state.draftTitle).toBe("New operations task");
  });
});

it("keeps page failures visible in the board editor and prioritizes its save failure", async () => {
  const page = mountPage({ boardId: "planning" });
  const request = expectDefined(page.request.getMockImplementation(), "request implementation");
  page.request.mockImplementation(async (method, params) => {
    if (method === "agents.list") {
      throw new Error("Agent metadata temporarily unavailable");
    }
    if (method === "workboard.cards.list") {
      return {
        cards: [],
        boards: [{ id: "planning", total: 0, active: 0, archived: 0, byStatus: {} }],
      };
    }
    if (method === "workboard.boards.upsert") {
      throw new Error("Board update denied");
    }
    return request(method, params);
  });
  page.fixture.connection.connected = true;
  page.fixture.notify();
  const form = await openBoardEditor(page);
  await vi.waitFor(() => {
    expect(
      visibleToast(page.container)?.shadowRoot?.querySelector('[role="alert"]')?.textContent,
    ).toBe("Agent metadata temporarily unavailable");
  });
  form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  await vi.waitFor(() => {
    expect(
      visibleToast(page.container)?.shadowRoot?.querySelector('[role="alert"]')?.textContent,
    ).toBe("Board update denied");
  });
});

it.each(["canWrite", "connected"] as const)(
  "preserves a board draft without saving when %s is revoked",
  async (capability) => {
    const page = mountPage({ boardId: "planning" });
    const request = expectDefined(page.request.getMockImplementation(), "request implementation");
    page.request.mockImplementation(async (method, params) =>
      method === "workboard.cards.list"
        ? {
            cards: [],
            boards: [
              { id: "planning", name: "Planning", total: 0, active: 0, archived: 0, byStatus: {} },
            ],
          }
        : request(method, params),
    );
    page.fixture.connection.connected = true;
    page.fixture.notify();
    const form = await openBoardEditor(page);
    const name = expectDefined(form.querySelector<HTMLInputElement>("input"), "board name");
    name.value = "Release planning";
    name.dispatchEvent(new Event("input", { bubbles: true }));
    page.fixture.connection[capability] = false;
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    expect(
      page.request.mock.calls.filter(([method]) => method === "workboard.boards.upsert"),
    ).toHaveLength(0);
    page.fixture.notify();
    await vi.waitFor(() =>
      expect(form.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(true),
    );
    expect(name.value).toBe("Release planning");
    page.fixture.connection[capability] = true;
    page.fixture.notify();
    await vi.waitFor(() =>
      expect(form.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(false),
    );
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await vi.waitFor(() =>
      expect(page.request).toHaveBeenCalledWith("workboard.boards.upsert", {
        id: "planning",
        name: "Release planning",
      }),
    );
    await vi.waitFor(() =>
      expect(page.container.querySelector(".workboard-board-draft")).toBeNull(),
    );
  },
);

async function openBoardEditor(page: ReturnType<typeof mountPage>) {
  await vi.waitFor(() => expect(page.workboard.state.loaded).toBe(true));
  expectDefined(
    page.container.querySelector<HTMLButtonElement>('button[aria-label="Edit board"]'),
    "edit board",
  ).click();
  return vi.waitFor(() =>
    expectDefined(
      page.container.querySelector<HTMLFormElement>(".workboard-board-draft"),
      "board editor",
    ),
  );
}
