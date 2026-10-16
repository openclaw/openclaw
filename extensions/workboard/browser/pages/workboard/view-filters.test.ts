import "../../test/dom.setup.ts";
import { expect, it, vi } from "vitest";
import {
  createWorkboardCard,
  createWorkboardTestClient,
} from "../../lib/workboard/test/index-helpers.ts";
import { waitForFast } from "../../test/wait-for.ts";
import {
  fill,
  submitForm,
  query,
  type AgentPicker,
  createWorkboardView,
  buttonByLabel,
  requireButton,
  textButton,
  filterPicker,
  statusButton,
  toast,
} from "./view.test-support.ts";

const agents = [
  { id: "main", name: "Main" },
  { id: "ops", name: "Ops" },
];
const roster = { defaultId: "main", agents };
const card = (title: string, overrides: Parameters<typeof createWorkboardCard>[0] = {}) =>
  createWorkboardCard({ id: title, title, ...overrides });
function filterView(props: Parameters<typeof createWorkboardView>[0] = {}) {
  const view = createWorkboardView(props);
  return {
    ...view,
    board: () => view.find(".workboard-board")?.textContent,
    click: (label: string) => {
      requireButton(view.container, label).click();
      view.renderView();
    },
  };
}

it("keeps refresh context accessible while loading", async () => {
  const { find, state, container, renderView } = createWorkboardView();
  state.loading = true;
  state.lastRefreshAt = new Date("2026-06-03T18:47:00Z").getTime();
  renderView();
  expect(buttonByLabel(container, "Compact")).not.toBeNull();
  const refresh = find(".workboard-refresh");
  expect(refresh?.parentElement?.getAttribute("title")).toContain("Refreshing");
  expect(refresh?.getAttribute("aria-busy")).toBe("true");
  expect(refresh?.textContent).not.toContain("Refreshing");
  state.loading = false;
  state.lastRefreshError = "Card refresh unavailable";
  renderView();
  const alert = () => toast(container)?.querySelector('[role="alert"]');
  await waitForFast(() => expect(alert()?.textContent?.trim()).toBe("Card refresh unavailable"));
  expect(buttonByLabel(container, "Refresh")?.disabled).toBe(false);
  state.lastRefreshError = null;
  renderView();
  await waitForFast(() => expect(alert()).toBeNull());
});

it("filters cards by multiple selected statuses from menu", () => {
  const { get, board, state, renderView } = filterView();
  state.cards = (["ready", "blocked", "done"] as const).map((s) =>
    card(`${s} card`, { status: s }),
  );
  renderView();
  const selectStatus = (label: string) =>
    textButton(get('[role="dialog"][aria-label="Status"]'), label === "All" ? "All work" : label);
  selectStatus("Ready").click();
  renderView();
  expect(board()).toContain("ready card");
  expect(board()).not.toContain("blocked card");
  selectStatus("Blocked").click();
  renderView();
  expect(state.statusFilter).toEqual(new Set(["ready", "blocked"]));
  expect(selectStatus("Ready").getAttribute("aria-pressed")).toBe("true");
  expect(selectStatus("Blocked").getAttribute("aria-pressed")).toBe("true");
  expect(selectStatus("All").getAttribute("aria-pressed")).toBe("false");
  expect(board()).toContain("blocked card");
  expect(board()).not.toContain("done card");
  selectStatus("All").click();
  renderView();
  expect(selectStatus("All").getAttribute("aria-pressed")).toBe("true");
  expect(board()).toContain("done card");
});

it("keeps zero-result status filters selectable and clearable", () => {
  const { find, state, container, renderView } = createWorkboardView();
  state.cards = [createWorkboardCard({ id: "ready", title: "Ready card", status: "ready" })];
  renderView();
  const running = statusButton(container, "Running");
  expect(running.disabled).toBe(false);
  running.click();
  renderView();
  expect(find(".workboard-empty-state")?.textContent).toContain("No cards match this view");
  textButton(find(".workboard-empty-state")!, "Clear filters").click();
  renderView();
  expect(state.statusFilter.size).toBe(0);
  expect(find(".workboard-board")?.textContent).toContain("Ready card");
});

it("keeps keyboard focus usable when search updates chips and chips are removed", async () => {
  const { get, all, state, container, renderView } = createWorkboardView();
  state.statusFilter = new Set(["ready", "blocked"]);
  state.priorityFilter = new Set(["high"]);
  state.searchOpen = true;
  renderView();
  const search = get<HTMLInputElement>("#workboard-search-input");
  search.focus();
  fill(search, "release");
  renderView();
  expect(document.activeElement).toBe(search);
  const removeSearch = requireButton(container, "Remove filter: Search: “release”");
  const visibleRect = new DOMRect(0, 0, 120, 32);
  const visibleRects = Object.assign([visibleRect], {
    item: (index: number) => (index === 0 ? visibleRect : null),
  });
  // This DOM harness has no layout; model the chips visible in the desktop toolbar.
  for (const chip of all<HTMLButtonElement>(".workboard-filter-chip__remove")) {
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
  expect(all(".workboard-filter-chip")).toHaveLength(0);
});

it("clears the mobile agent chip through global scope without clearing other filters", () => {
  const onClearAgentScope = vi.fn();
  const { board, state, container, renderView } = filterView({
    scopeAgentId: "writer",
    agentsList: { defaultId: "main", agents: [{ id: "main" }, { id: "writer" }] },
    onClearAgentScope,
  });
  state.priorityFilter = new Set(["high"]);
  state.statusFilter = new Set(["ready"]);
  state.cards = [
    card("Writer card", { agentId: "writer", status: "ready", priority: "high" }),
    card("Main card", { agentId: "main", status: "ready", priority: "high" }),
    card("Low priority", { agentId: "main", status: "ready", priority: "low" }),
  ];
  renderView();
  expect(board()).not.toContain("Main card");
  requireButton(container, "Remove filter: Agent: writer").click();
  expect(onClearAgentScope).toHaveBeenCalledOnce();
  renderView({ scopeAgentId: null });
  expect(buttonByLabel(container, "Remove filter: Agent: writer")).toBeNull();
  expect(board()).toContain("Main card");
  expect(board()).toContain("Writer card");
  expect(board()).not.toContain("Low priority");
  expect(state).toMatchObject({
    priorityFilter: new Set(["high"]),
    statusFilter: new Set(["ready"]),
  });
});

it("keeps list group actions independent of its disclosure while collapsed", () => {
  const { get, state, renderView } = createWorkboardView({ canWrite: true });
  state.viewMode = "list";
  state.cards = [createWorkboardCard({ id: "todo-card", title: "Review notes", status: "todo" })];
  state.collapsedStatuses.add("todo");
  renderView();
  const group = get('section[aria-label="Todo, 1"]');
  query<HTMLButtonElement>(group, "button[popovertarget]").click();
  expect(group.querySelector("h2 button")?.getAttribute("aria-expanded")).toBe("false");
  textButton(group, "Select all").click();
  renderView();
  expect(state.selectedCardIds).toEqual(new Set(["todo-card"]));
  expect(group.querySelector('[role="listitem"]')).toBeNull();
  requireButton(group, "New card in Todo").click();
  renderView();
  expect(state).toMatchObject({ draftOpen: true, draftStatus: "todo" });
  expect(state.collapsedStatuses).toContain("todo");
});

it("supports showing, collapsing, and hiding empty columns", () => {
  const { find, all, state, click, renderView } = filterView();
  state.cards = [createWorkboardCard({ title: "Keep visible" })];
  renderView();
  expect(all(".workboard-column")).toHaveLength(9);
  expect(find(".workboard-column--collapsed")).toBeNull();
  click("Collapse empty");
  expect(state.emptyColumnMode).toBe("collapse");
  expect(all(".workboard-column")).toHaveLength(9);
  expect(all(".workboard-column--collapsed")).toHaveLength(8);
  expect(find(".workboard-column--todo")?.classList).not.toContain("workboard-column--collapsed");
  click("Collapse Todo column");
  expect(state.collapsedStatuses).toContain("todo");
  expect(find(".workboard-column--todo")?.classList).toContain("workboard-column--collapsed");
  click("Expand Todo column");
  expect(state.collapsedStatuses).not.toContain("todo");
  click("Hide empty");
  expect(state.emptyColumnMode).toBe("hide");
  expect(all(".workboard-column")).toHaveLength(1);
  expect(find(".workboard-column--todo")).not.toBeNull();
});

it.each([
  ["the selected named agent filter", null, "ops", "ops"],
  ["the unassigned default-agent filter", null, "default", ""],
  ["a selected named agent before its roster loads", "writer", "all", "writer"],
] as const)("initializes cards from %s", (_name, scope, agentFilter, expected) => {
  const { get, state, click, renderView } = filterView({
    agentsList: scope
      ? null
      : {
          defaultId: "main",
          agents: [
            ...agents,
            { id: "writer", name: "Writer" },
            { id: "workboard-dispatcher", kind: "system", name: "Dispatcher" },
          ],
        },
    ...(scope ? { defaultAgentId: "main" } : {}),
    scopeAgentId: scope,
  });
  state.agentFilter = agentFilter;
  renderView();
  click("New card");
  expect(state).toMatchObject({ draftOpen: true, draftAgentId: expected });
  expect(get<AgentPicker>(".workboard-draft [data-test-agent-picker]").value).toBe(expected);
});

it("keeps a new default-agent card visible in research scope before metadata loads", async () => {
  const created = card("New default-agent work");
  const client = createWorkboardTestClient({ "workboard.cards.create": { card: created } });
  const { get, board, state, container, click, renderView } = filterView({
    client,
    defaultAgentId: "research",
    scopeAgentId: "research",
  });
  state.cards = [
    card("Assigned default work", { agentId: "research" }),
    card("Other agent work", { agentId: "writer" }),
  ];
  renderView();
  click("New card");
  fill(get<HTMLInputElement>(".workboard-draft__title"), created.title);
  submitForm(get<HTMLFormElement>(".workboard-draft"));
  await waitForFast(() => expect(state.draftOpen).toBe(false));
  renderView();
  expect(client.request).toHaveBeenCalledWith(
    "workboard.cards.create",
    expect.objectContaining({ title: created.title, agentId: "" }),
  );
  expect(board()).toContain(created.title);
  expect(board()).not.toContain("Other agent work");
  statusButton(container, "Todo").click();
  renderView();
  statusButton(container, "All").click();
  renderView();
  expect(board()).toContain(created.title);
  expect(board()).toContain("Assigned default work");
});

it.each(["board", "agent"] as const)("filters cards through the %s picker", (kind) => {
  const board = kind === "board";
  const onBoardFilterChange = vi.fn();
  const { state, container, renderView } = createWorkboardView({
    ...(board ? { onBoardFilterChange } : {}),
    agentsList: board ? null : roster,
  });
  if (board) {
    const counts = { total: 1, active: 1, archived: 0, byStatus: { todo: 1 } };
    state.boards = [
      { ...counts, id: "default" },
      { ...counts, id: "ops", name: "Operations" },
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
  const hiddenTitle = board ? "Default work" : "Main work";
  state.cards = [
    card(hiddenTitle, board ? {} : { agentId: "main" }),
    card("Ops work", {
      position: 2000,
      ...(board ? { metadata: { automation: { boardId: "ops" } } } : { agentId: "ops" }),
    }),
  ];
  if (!board) {
    state.cards.push(card("Dispatcher work", { agentId: "workboard-dispatcher", position: 3000 }));
  }
  renderView();
  const picker = filterPicker(container, board ? "Filter by board" : "Agent");
  const labels = board
    ? ["Default board", "Operations (ops)", "Old work (archive)"]
    : [
        "All agents",
        "Unassigned (uses Main)",
        "Main (default)",
        "Ops",
        "workboard-dispatcher (not configured)",
      ];
  expect(picker.options.map((option) => option.label)).toEqual(expect.arrayContaining(labels));
  picker.onSelect("ops");
  renderView();
  expect(container.textContent).not.toContain(hiddenTitle);
  expect(container.textContent).toContain("Ops work");
  if (board) {
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
  const { get, state, renderView } = createWorkboardView({
    agentsList: {
      defaultId: "main",
      agents: [...agents.slice(0, 1), { id: "main", name: "Main duplicate" }, ...agents.slice(1)],
    },
  });
  state.draftOpen = true;
  state.draftAgentId = "workboard-dispatcher";
  state.cards = [createWorkboardCard({ title: "Assign me", agentId: "workboard-dispatcher" })];
  renderView();
  const agentSelect = get<AgentPicker>(".workboard-draft [data-test-agent-picker]");
  const labels = agentSelect.options.map((option) => option.label);
  expect(labels).toEqual(["Main", "Main", "Ops", "workboard-dispatcher (not configured)"]);
  expect(agentSelect?.options.find((option) => option.label === "Main")?.badge).toBe("Default");
  expect(agentSelect?.options.find((option) => option.label === "Ops")?.badge).toBeUndefined();
  expect(agentSelect.options.find((option) => option.value === "main")?.badge).toBeUndefined();
  agentSelect.onSelect("");
  renderView();
  expect(state.draftAgentId).toBe("");
  expect(agentSelect.value).toBe("");
});

it("keeps inherited detail assignment current across default and connection changes", async () => {
  const assigned = createWorkboardCard({ agentId: "ops" });
  const client = createWorkboardTestClient({
    "workboard.cards.update": { card: createWorkboardCard({ updatedAt: 2 }) },
  });
  const { get, state, renderView } = createWorkboardView({ client, agentsList: roster });
  state.cards = [assigned];
  state.detailCardId = assigned.id;
  renderView();
  const picker = get<AgentPicker>(".workboard-detail__agent-picker [data-test-agent-picker]");
  const inherited = () => picker.options.find((option) => option.value === "");
  expect(inherited()).toMatchObject({ label: "Main", badge: "Default" });
  picker.onSelect("");
  await vi.waitFor(() => expect(state.cards[0]?.agentId).toBeUndefined());
  expect(client.request).toHaveBeenCalledWith("workboard.cards.update", {
    id: assigned.id,
    expectedUpdatedAt: assigned.updatedAt,
    patch: { agentId: "" },
  });
  renderView({ agentsList: { defaultId: "ops", agents } });
  expect(picker.value).toBe("");
  expect(inherited()).toMatchObject({ label: "Ops", badge: "Default" });
  renderView({ connected: false });
  expect(picker.disabled).toBe(true);
  renderView({ client: null });
  expect(picker.disabled).toBe(true);
  renderView();
  expect(picker.disabled).toBe(false);
});
