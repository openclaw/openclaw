import "../../test/dom.setup.ts";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import {
  createWorkboardCard,
  createWorkboardTestClient,
} from "../../lib/workboard/test/index-helpers.ts";
import { waitForFast } from "../../test/wait-for.ts";
import {
  type AgentPicker,
  createWorkboardView,
  buttonByLabel,
  requireButton,
  textButton,
  filterPicker,
  statusButton,
  toast,
} from "./view.test-support.ts";

describe("WorkboardView", () => {
  it("keeps refresh context accessible while loading", async () => {
    const { state, container, renderView } = createWorkboardView();
    state.loading = true;
    state.lastRefreshAt = new Date("2026-06-03T18:47:00Z").getTime();
    renderView();
    expect(buttonByLabel(container, "Compact")).not.toBeNull();
    expect(
      container.querySelector(".workboard-refresh")?.parentElement?.getAttribute("title"),
    ).toContain("Refreshing");
    expect(container.querySelector(".workboard-refresh")?.getAttribute("aria-busy")).toBe("true");
    expect(container.querySelector(".workboard-refresh")?.textContent).not.toContain("Refreshing");
    state.loading = false;
    state.lastRefreshError = "Card refresh unavailable";
    renderView();
    await waitForFast(() =>
      expect(toast(container)?.querySelector('[role="alert"]')?.textContent?.trim()).toBe(
        "Card refresh unavailable",
      ),
    );
    expect(buttonByLabel(container, "Refresh")?.disabled).toBe(false);
    state.lastRefreshError = null;
    renderView();
    await waitForFast(() => expect(toast(container)?.querySelector('[role="alert"]')).toBeNull());
  });

  it("filters cards by multiple selected statuses from menu", () => {
    const { state, container, renderView } = createWorkboardView();
    state.cards = [
      createWorkboardCard({ id: "ready", title: "Ready card", status: "ready" }),
      createWorkboardCard({ id: "blocked", title: "Blocked card", status: "blocked" }),
      createWorkboardCard({ id: "done", title: "Done card", status: "done" }),
    ];
    renderView();
    const selectStatus = (label: string) =>
      textButton(
        expectDefined(
          container.querySelector<HTMLElement>('[role="dialog"][aria-label="Status"]'),
          '[role="dialog"][aria-label="Status"]',
        ),
        label === "All" ? "All work" : label,
      );
    selectStatus("Ready").click();
    renderView();
    expect(container.querySelector(".workboard-board")?.textContent).toContain("Ready card");
    expect(container.querySelector(".workboard-board")?.textContent).not.toContain("Blocked card");
    selectStatus("Blocked").click();
    renderView();
    expect(state.statusFilter).toEqual(new Set(["ready", "blocked"]));
    expect(selectStatus("Ready").getAttribute("aria-pressed")).toBe("true");
    expect(selectStatus("Blocked").getAttribute("aria-pressed")).toBe("true");
    expect(selectStatus("All").getAttribute("aria-pressed")).toBe("false");
    expect(container.querySelector(".workboard-board")?.textContent).toContain("Blocked card");
    expect(container.querySelector(".workboard-board")?.textContent).not.toContain("Done card");
    selectStatus("All").click();
    renderView();
    expect(selectStatus("All").getAttribute("aria-pressed")).toBe("true");
    expect(container.querySelector(".workboard-board")?.textContent).toContain("Done card");
  });

  it("keeps zero-result status filters selectable and clearable", () => {
    const { state, container, renderView } = createWorkboardView();
    state.cards = [createWorkboardCard({ id: "ready", title: "Ready card", status: "ready" })];
    renderView();
    const running = statusButton(container, "Running");
    expect(running.disabled).toBe(false);
    running.click();
    renderView();
    expect(container.querySelector(".workboard-empty-state")?.textContent).toContain(
      "No cards match this view",
    );
    textButton(container.querySelector(".workboard-empty-state")!, "Clear filters").click();
    renderView();
    expect(state.statusFilter.size).toBe(0);
    expect(container.querySelector(".workboard-board")?.textContent).toContain("Ready card");
  });

  it("keeps keyboard focus usable when search updates chips and chips are removed", async () => {
    const { state, container, renderView } = createWorkboardView();
    state.statusFilter = new Set(["ready", "blocked"]);
    state.priorityFilter = new Set(["high"]);
    state.searchOpen = true;
    renderView();
    const search = expectDefined(
      container.querySelector<HTMLInputElement>("#workboard-search-input"),
      "#workboard-search-input",
    );
    search.focus();
    search.value = "release";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    renderView();
    expect(document.activeElement).toBe(search);
    const removeSearch = requireButton(container, "Remove filter: Search: “release”");
    const visibleRect = new DOMRect(0, 0, 120, 32);
    const visibleRects = Object.assign([visibleRect], {
      item: (index: number) => (index === 0 ? visibleRect : null),
    });
    // This DOM harness has no layout; model the chips visible in the desktop toolbar.
    for (const chip of container.querySelectorAll<HTMLButtonElement>(
      ".workboard-filter-chip__remove",
    )) {
      vi.spyOn(chip, "getClientRects").mockReturnValue(visibleRects);
    }
    removeSearch.focus();
    removeSearch.click();
    renderView();
    await Promise.resolve();
    expect(state.query).toBe("");
    const removePriority = requireButton(container, "Remove filter: Priority: High");
    expect(document.activeElement).toBe(removePriority);
    expect(state.statusFilter).toEqual(new Set(["ready", "blocked"]));
    removePriority.click();
    renderView();
    await Promise.resolve();
    expect(document.activeElement).toBe(buttonByLabel(container, "Filters"));
    expect(container.querySelectorAll(".workboard-filter-chip")).toHaveLength(0);
  });

  it("clears the mobile agent chip through global scope without clearing other filters", () => {
    const onClearAgentScope = vi.fn();
    const { state, container, renderView } = createWorkboardView({
      scopeAgentId: "writer",
      agentsList: { defaultId: "main", agents: [{ id: "main" }, { id: "writer" }] },
      onClearAgentScope,
    });
    state.priorityFilter = new Set(["high"]);
    state.statusFilter = new Set(["ready"]);
    state.cards = [
      createWorkboardCard({
        id: "writer-card",
        title: "Writer card",
        agentId: "writer",
        status: "ready",
        priority: "high",
      }),
      createWorkboardCard({
        id: "main-card",
        title: "Main card",
        agentId: "main",
        status: "ready",
        priority: "high",
      }),
      createWorkboardCard({
        id: "low-card",
        title: "Low priority",
        agentId: "main",
        status: "ready",
        priority: "low",
      }),
    ];
    renderView();
    expect(container.querySelector(".workboard-board")?.textContent).not.toContain("Main card");
    requireButton(container, "Remove filter: Agent: writer").click();
    expect(onClearAgentScope).toHaveBeenCalledOnce();
    renderView({ scopeAgentId: null });
    expect(buttonByLabel(container, "Remove filter: Agent: writer")).toBeNull();
    expect(container.querySelector(".workboard-board")?.textContent).toContain("Main card");
    expect(container.querySelector(".workboard-board")?.textContent).toContain("Writer card");
    expect(container.querySelector(".workboard-board")?.textContent).not.toContain("Low priority");
    expect(state.priorityFilter).toEqual(new Set(["high"]));
    expect(state.statusFilter).toEqual(new Set(["ready"]));
  });

  it("keeps list group actions independent of its disclosure while collapsed", () => {
    const { state, container, renderView } = createWorkboardView({ canWrite: true });
    state.viewMode = "list";
    state.cards = [createWorkboardCard({ id: "todo-card", title: "Review notes", status: "todo" })];
    state.collapsedStatuses.add("todo");
    renderView();
    const group = expectDefined(
      container.querySelector<HTMLElement>('section[aria-label="Todo, 1"]'),
      'section[aria-label="Todo, 1"]',
    );
    const actions = expectDefined(
      group.querySelector<HTMLButtonElement>("button[popovertarget]"),
      "button[popovertarget]",
    );
    actions.click();
    expect(group.querySelector("h2 button")?.getAttribute("aria-expanded")).toBe("false");
    textButton(group, "Select all").click();
    renderView();
    expect(state.selectedCardIds).toEqual(new Set(["todo-card"]));
    expect(group.querySelector('[role="listitem"]')).toBeNull();
    requireButton(group, "New card in Todo").click();
    renderView();
    expect(state.draftOpen).toBe(true);
    expect(state.draftStatus).toBe("todo");
    expect(state.collapsedStatuses).toContain("todo");
  });

  it("supports showing, collapsing, and hiding empty columns", () => {
    const { state, container, renderView } = createWorkboardView({
      onRequestUpdate: () => undefined,
    });
    state.cards = [createWorkboardCard({ title: "Keep visible" })];
    renderView();
    expect(container.querySelectorAll(".workboard-column")).toHaveLength(9);
    expect(container.querySelector(".workboard-column--collapsed")).toBeNull();
    buttonByLabel(container, "Collapse empty")?.click();
    renderView();
    expect(state.emptyColumnMode).toBe("collapse");
    expect(container.querySelectorAll(".workboard-column")).toHaveLength(9);
    expect(container.querySelectorAll(".workboard-column--collapsed")).toHaveLength(8);
    expect(container.querySelector(".workboard-column--todo")?.classList).not.toContain(
      "workboard-column--collapsed",
    );
    buttonByLabel(container, "Collapse Todo column")?.click();
    renderView();
    expect(state.collapsedStatuses).toContain("todo");
    expect(container.querySelector(".workboard-column--todo")?.classList).toContain(
      "workboard-column--collapsed",
    );
    buttonByLabel(container, "Expand Todo column")?.click();
    renderView();
    expect(state.collapsedStatuses).not.toContain("todo");
    buttonByLabel(container, "Hide empty")?.click();
    renderView();
    expect(state.emptyColumnMode).toBe("hide");
    expect(container.querySelectorAll(".workboard-column")).toHaveLength(1);
    expect(container.querySelector(".workboard-column--todo")).not.toBeNull();
  });

  it.each([
    {
      name: "the selected named agent filter",
      scopeAgentId: null,
      agentFilter: "ops",
      expectedAgentId: "ops",
    },
    {
      name: "the unassigned default-agent filter",
      scopeAgentId: null,
      agentFilter: "default",
      expectedAgentId: "",
    },
    {
      name: "a selected named agent before its roster loads",
      scopeAgentId: "writer",
      agentFilter: "all",
      expectedAgentId: "writer",
    },
  ])("initializes new cards from $name", ({ scopeAgentId, agentFilter, expectedAgentId }) => {
    const { state, container, renderView } = createWorkboardView({
      agentsList: scopeAgentId
        ? null
        : {
            defaultId: "main",
            agents: [
              { id: "main", name: "Main" },
              { id: "writer", name: "Writer" },
              { id: "ops", name: "Ops" },
              { id: "workboard-dispatcher", kind: "system", name: "Dispatcher" },
            ],
          },
      ...(scopeAgentId ? { defaultAgentId: "main" } : {}),
      scopeAgentId,
    });
    state.agentFilter = agentFilter;
    renderView();
    container
      .querySelector<HTMLButtonElement>(".workboard-heading__actions .workboard-create")
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    renderView();
    expect(state.draftOpen).toBe(true);
    expect(state.draftAgentId).toBe(expectedAgentId);
    expect(
      container.querySelector<
        HTMLElement & {
          value: string;
        }
      >(".workboard-draft .workboard-agent-select [data-test-agent-picker]")?.value,
    ).toBe(expectedAgentId);
  });

  it("keeps a new default-agent card visible in research scope before metadata loads", async () => {
    const created = createWorkboardCard({ id: "created", title: "New default-agent work" });
    const client = createWorkboardTestClient({ "workboard.cards.create": { card: created } });
    const { state, container, renderView } = createWorkboardView({
      client,
      defaultAgentId: "research",
      scopeAgentId: "research",
    });
    state.cards = [
      createWorkboardCard({ id: "assigned", title: "Assigned default work", agentId: "research" }),
      createWorkboardCard({ id: "other", title: "Other agent work", agentId: "writer" }),
    ];
    renderView();
    textButton(container, "New card").click();
    renderView();
    const title = expectDefined(
      container.querySelector<HTMLInputElement>(".workboard-draft__title"),
      ".workboard-draft__title",
    );
    title.value = created.title;
    title.dispatchEvent(new InputEvent("input", { bubbles: true }));
    container
      .querySelector<HTMLFormElement>(".workboard-draft")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await waitForFast(() => expect(state.draftOpen).toBe(false));
    renderView();
    expect(client.request).toHaveBeenCalledWith(
      "workboard.cards.create",
      expect.objectContaining({ title: created.title, agentId: "" }),
    );
    expect(container.querySelector(".workboard-board")?.textContent).toContain(created.title);
    expect(container.querySelector(".workboard-board")?.textContent).not.toContain(
      "Other agent work",
    );
    statusButton(container, "Todo").click();
    renderView();
    statusButton(container, "All").click();
    renderView();
    expect(container.querySelector(".workboard-board")?.textContent).toContain(created.title);
    expect(container.querySelector(".workboard-board")?.textContent).toContain(
      "Assigned default work",
    );
  });

  it.each(["board", "agent"] as const)("filters cards through the %s picker", (kind) => {
    const onBoardFilterChange = vi.fn();
    const { state, container, renderView } = createWorkboardView({
      ...(kind === "board" ? { onBoardFilterChange } : {}),
      agentsList:
        kind === "agent"
          ? {
              defaultId: "main",
              agents: [
                { id: "main", name: "Main" },
                { id: "ops", name: "Ops" },
              ],
            }
          : null,
    });
    if (kind === "board") {
      state.boards = [
        { id: "default", total: 1, active: 1, archived: 0, byStatus: { todo: 1 } },
        { id: "ops", name: "Operations", total: 1, active: 1, archived: 0, byStatus: { todo: 1 } },
        {
          id: "archive",
          name: "Old work",
          total: 0,
          active: 0,
          archived: 0,
          byStatus: {},
          archivedAt: 7,
        },
      ];
    }
    const hiddenTitle = kind === "board" ? "Default work" : "Main work";
    state.cards = [
      createWorkboardCard({
        title: hiddenTitle,
        ...(kind === "board" ? { id: "card-default" } : { agentId: "main" }),
      }),
      createWorkboardCard({
        id: kind === "board" ? "card-ops" : "card-2",
        title: "Ops work",
        position: 2000,
        ...(kind === "board"
          ? { metadata: { automation: { boardId: "ops" } } }
          : { agentId: "ops" }),
      }),
    ];
    if (kind === "agent") {
      state.cards.push(
        createWorkboardCard({
          id: "card-3",
          title: "Dispatcher work",
          agentId: "workboard-dispatcher",
          position: 3000,
        }),
      );
    }
    renderView();
    const picker = filterPicker(container, kind === "board" ? "Filter by board" : "Agent");
    if (kind === "board") {
      expect(picker.options.map((option) => option.label)).toEqual(
        expect.arrayContaining(["Default board", "Operations (ops)", "Old work (archive)"]),
      );
    } else {
      for (const label of [
        "All agents",
        "Unassigned (uses Main)",
        "Main (default)",
        "Ops",
        "workboard-dispatcher (not configured)",
      ]) {
        expect(picker.options.map((option) => option.label)).toContain(label);
      }
    }
    picker.onSelect("ops");
    renderView();
    expect(container.textContent).not.toContain(hiddenTitle);
    expect(container.textContent).toContain("Ops work");
    if (kind === "board") {
      expect(onBoardFilterChange).toHaveBeenCalledWith("ops");
    } else {
      expect(state.agentFilter).toBe("ops");
      filterPicker(container, "Agent").onSelect("workboard-dispatcher");
      renderView();
      expect(container.textContent).not.toContain("Ops work");
      expect(container.textContent).toContain("Dispatcher work");
      expect(state.agentFilter).toBe("workboard-dispatcher");
    }
  });

  it("limits assignment choices to configured agents and preserves an unknown current assignee", () => {
    const { state, container, renderView } = createWorkboardView({
      agentsList: {
        defaultId: "main",
        agents: [
          { id: "main", name: "Main" },
          { id: "main", name: "Main duplicate" },
          { id: "ops", name: "Ops" },
        ],
      },
    });
    state.draftOpen = true;
    state.draftTitle = "Assign me";
    state.draftAgentId = "workboard-dispatcher";
    state.cards = [createWorkboardCard({ title: "Assign me", agentId: "workboard-dispatcher" })];
    renderView();
    const draft = container.querySelector<HTMLElement>(".workboard-draft");
    const agentSelect = expectDefined(
      draft?.querySelector<AgentPicker>(".workboard-agent-select [data-test-agent-picker]"),
      ".workboard-agent-select [data-test-agent-picker]",
    );
    expect(agentSelect?.options.map((option) => option.label)).toEqual([
      "Main",
      "Main",
      "Ops",
      "workboard-dispatcher (not configured)",
    ]);
    expect(agentSelect?.options.find((option) => option.label === "Main")?.badge).toBe("Default");
    expect(agentSelect?.options.find((option) => option.label === "Ops")?.badge).toBeUndefined();
    expect(agentSelect.options.find((option) => option.value === "main")?.badge).toBeUndefined();
    agentSelect.onSelect("");
    renderView();
    expect(state.draftAgentId).toBe("");
    expect(agentSelect.value).toBe("");
  });

  it("keeps inherited detail assignment current across default and connection changes", async () => {
    const card = createWorkboardCard({ agentId: "ops" });
    const client = createWorkboardTestClient({
      "workboard.cards.update": { card: createWorkboardCard({ updatedAt: 2 }) },
    });
    const agents = [
      { id: "main", name: "Main" },
      { id: "ops", name: "Ops" },
    ];
    const { state, container, renderView } = createWorkboardView({
      client,
      agentsList: { defaultId: "main", agents },
    });
    state.cards = [card];
    state.detailCardId = card.id;
    renderView();
    const picker = expectDefined(
      container.querySelector<AgentPicker>(
        ".workboard-detail__agent-picker [data-test-agent-picker]",
      ),
      ".workboard-detail__agent-picker [data-test-agent-picker]",
    );
    expect(picker.options.find((option) => option.value === "")).toMatchObject({
      label: "Main",
      badge: "Default",
    });
    picker.onSelect("");
    await vi.waitFor(() => expect(state.cards[0]?.agentId).toBeUndefined());
    expect(client.request).toHaveBeenCalledWith("workboard.cards.update", {
      id: card.id,
      expectedUpdatedAt: card.updatedAt,
      patch: { agentId: "" },
    });
    renderView({ agentsList: { defaultId: "ops", agents } });
    expect(picker.value).toBe("");
    expect(picker.options.find((option) => option.value === picker.value)).toMatchObject({
      label: "Ops",
      badge: "Default",
    });
    renderView({ connected: false });
    expect(picker.disabled).toBe(true);
    renderView({ client: null });
    expect(picker.disabled).toBe(true);
    renderView();
    expect(picker.disabled).toBe(false);
  });
});
