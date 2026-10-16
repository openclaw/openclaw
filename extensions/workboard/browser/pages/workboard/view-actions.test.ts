import "../../test/dom.setup.ts";
import { GatewayProtocolRequestError } from "@openclaw/gateway-client/browser";
import { expectDefined } from "@openclaw/normalization-core";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { describe, expect, it, vi } from "vitest";
import { setWorkboardCards } from "../../lib/workboard/card-state.ts";
import { resetWorkboardConnectionState } from "../../lib/workboard/index.ts";
import { createWorkboardCard } from "../../lib/workboard/test/index-helpers.ts";
import { workboardTestHost } from "../../test/host.setup.ts";
import { waitForFast } from "../../test/wait-for.ts";
import {
  query,
  type SelectPicker,
  createWorkboardView,
  buttonByLabel,
  buttonByText,
  requireButton,
} from "./view.test-support.ts";

type Card = ReturnType<typeof createWorkboardCard>;
const agentsList = { defaultId: "main", agents: [{ id: "main" }, { id: "writer" }] };
function cardPair(overrides: Partial<Card> = {}) {
  return [
    createWorkboardCard({ id: "first", ...overrides }),
    createWorkboardCard({ id: "second", position: 2000, ...overrides }),
  ] as const;
}
function linkedCards(parentTitle = "Build board", childTitle = "Build board") {
  return [
    createWorkboardCard({ id: "parent", title: parentTitle }),
    createWorkboardCard({
      id: "child",
      title: childTitle,
      position: 2000,
      metadata: { links: [{ id: "link", type: "parent", targetCardId: "parent", createdAt: 1 }] },
    }),
  ] as const;
}
function bulkView(cards: Card[], overrides: Parameters<typeof createWorkboardView>[0]) {
  const view = createWorkboardView({ canWrite: true, ...overrides });
  view.state.cards = cards;
  view.state.selectedCardIds = new Set(cards.map((card) => card.id));
  view.renderView();
  return view;
}
function confirmDelete(view: ReturnType<typeof createWorkboardView>) {
  view.get<HTMLButtonElement>('.workboard-bulk-dialog button[type="submit"]').click();
}
function conflict(card: Card) {
  return new GatewayProtocolRequestError({
    code: "workboard_conflict",
    message: "Card changed. Review and retry.",
    details: { type: "workboard_card_conflict", card },
  });
}
function key(element: Element, value: string, shiftKey = false) {
  return element.dispatchEvent(
    new KeyboardEvent("keydown", { key: value, shiftKey, bubbles: true, cancelable: true }),
  );
}

describe("WorkboardView", () => {
  it("retries only pending bulk edits after the second card fails", async () => {
    const [first, second] = cardPair({ agentId: "writer" });
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        card: { ...first, agentId: "main", updatedAt: first.updatedAt + 1 },
      })
      .mockRejectedValueOnce(new Error("Second card update rejected"))
      .mockResolvedValueOnce({
        card: { ...second, agentId: "main", updatedAt: second.updatedAt + 1 },
      });
    const { get, find, state, container, renderView } = bulkView([first, second], {
      client: { request },
      agentsList,
    });
    requireButton(container, "Edit properties").click();
    renderView();
    const picker = get<SelectPicker>(".workboard-bulk-dialog [data-test-select-picker]");
    expect(picker.accessibleLabel).toBe("Agent");
    picker.onSelect("main");
    renderView();
    requireButton(container, "Apply changes").click();
    await vi.waitFor(() => expect(state.bulkSaving).toBe(false));
    expect(request).toHaveBeenCalledTimes(2);
    expect(state.cards.find((card) => card.id === first.id)?.agentId).toBe("main");
    expect(state.cards.find((card) => card.id === second.id)?.agentId).toBe("writer");
    expect(state.selectedCardIds).toEqual(new Set([second.id]));
    expect(state.bulkDialog?.cardIds).toEqual([second.id]);
    expect(state.bulkResult).toEqual({ completed: 1, total: 2 });
    renderView();
    await waitForFast(() => {
      const errorToast = find("openclaw-workboard-toast:not([hidden])");
      expect(errorToast?.querySelector('[role="alert"]')?.textContent).toContain(
        "Applied to 1 of 2 cards. Second card update rejected",
      );
    });
    requireButton(container, "Apply changes").click();
    await vi.waitFor(() => expect(state.bulkSaving).toBe(false));
    expect(request.mock.calls).toEqual(
      [first, second, second].map((card) => [
        "workboard.cards.update",
        { id: card.id, expectedUpdatedAt: card.updatedAt, patch: { agentId: "main" } },
      ]),
    );
    expect(state.cards.every((card) => card.agentId === "main")).toBe(true);
    expect(state.selectedCardIds.size).toBe(0);
    expect(state).toMatchObject({ bulkDialog: null, error: null });
    expect(state.bulkResult).toEqual({ completed: 1, total: 1 });
  });

  it.each(["write revocation", "disconnect", "activation disposal"] as const)(
    "stops a bulk assignment after %s changes while the first write is pending",
    async (change) => {
      const [first, second] = cardPair({ agentId: "writer" });
      const firstWrite = createDeferred<{ card: typeof first }>();
      const request = vi
        .fn()
        .mockReturnValueOnce(firstWrite.promise)
        .mockResolvedValue({ card: { ...second, agentId: "main" } });
      const { all, state } = bulkView([first, second], { client: { request }, agentsList });
      const picker = expectDefined(
        [...all<SelectPicker>(".workboard-selection [data-test-select-picker]")].find(
          (item) => item.accessibleLabel === "Assign agent…",
        ),
        "bulk assignment",
      );
      picker.onSelect("main");
      await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
      expect(state.bulkSaving).toBe(true);
      const connection = workboardTestHost().connection;
      if (change === "disconnect") {
        connection.connected = false;
      } else if (change === "write revocation") {
        connection.canWrite = false;
      } else {
        workboardTestHost().dispose();
      }
      firstWrite.resolve({ card: { ...first, agentId: "main", updatedAt: first.updatedAt + 1 } });
      await vi.waitFor(() => expect(state.bulkSaving).toBe(false));
      expect(request).toHaveBeenCalledTimes(1);
      expect(request).toHaveBeenCalledWith("workboard.cards.update", {
        id: first.id,
        expectedUpdatedAt: first.updatedAt,
        patch: { agentId: "main" },
      });
      expect(state.cards.find((card) => card.id === first.id)?.agentId).toBe("main");
      expect(state.cards.find((card) => card.id === second.id)?.agentId).toBe("writer");
      expect(state.selectedCardIds).toEqual(new Set([second.id]));
      expect(state.bulkResult).toEqual({ completed: 1, total: 2 });
      expect(state.error).toContain("Applied to 1 of 2 cards.");
    },
  );

  it("drops a selected card made ineligible by archive while bulk work is pending", async () => {
    const [first, second] = cardPair();
    const outside = { ...second, metadata: { archivedAt: second.updatedAt + 1 } };
    const pending = createDeferred<{ deleted: boolean }>();
    const request = vi
      .fn()
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValue({ deleted: true });
    const view = bulkView([first, second], { client: { request } });
    const { get, state, renderView } = view;
    get<HTMLButtonElement>(".workboard-selection__delete").click();
    renderView();
    expect(state.bulkDialog?.cardIds).toEqual([first.id, second.id]);
    confirmDelete(view);
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    setWorkboardCards(state, [first, outside]);
    pending.resolve({ deleted: true });
    await vi.waitFor(() => expect(state.bulkSaving).toBe(false));
    expect(request).toHaveBeenCalledTimes(1);
    expect(state.selectedCardIds.size).toBe(0);
    expect(request).toHaveBeenCalledWith("workboard.cards.delete", {
      id: first.id,
      expectedUpdatedAt: first.updatedAt,
    });
    expect(state.cards).toEqual([outside]);
    expect(state.bulkDialog).toBeNull();
  });

  it.each(["none", "before cleanup", "after cleanup"] as const)(
    "deletes linked selections without adopting unrelated edits: %s",
    async (concurrentEdit) => {
      const [parent, child] = linkedCards();
      const previousUpdatedAt = child.updatedAt + (concurrentEdit === "before cleanup" ? 1 : 0);
      const cleanupUpdatedAt = previousUpdatedAt + 1;
      const latest = {
        ...child,
        metadata: undefined,
        updatedAt: cleanupUpdatedAt + (concurrentEdit === "after cleanup" ? 1 : 0),
        title: concurrentEdit === "none" ? child.title : "Edited by another client",
      };
      const request = vi.fn().mockImplementation(async (_method, params) => {
        if (params.id === parent.id) {
          if (concurrentEdit !== "none") {
            setWorkboardCards(state, [
              parent,
              {
                ...latest,
                updatedAt:
                  concurrentEdit === "before cleanup" ? previousUpdatedAt : latest.updatedAt,
              },
            ]);
          }
          return {
            deleted: true,
            referenceUpdates: [{ id: child.id, previousUpdatedAt, updatedAt: cleanupUpdatedAt }],
          };
        }
        if (params.expectedUpdatedAt !== latest.updatedAt) {
          throw conflict(latest);
        }
        return { deleted: true };
      });
      const view = bulkView([parent, child], { client: { request } });
      const { get, state, renderView } = view;
      get<HTMLButtonElement>(".workboard-selection__delete").click();
      renderView();
      confirmDelete(view);
      await vi.waitFor(() => expect(state.bulkSaving).toBe(false));
      expect(request).toHaveBeenCalledTimes(2);
      expect(request).toHaveBeenNthCalledWith(2, "workboard.cards.delete", {
        id: child.id,
        expectedUpdatedAt: concurrentEdit === "before cleanup" ? child.updatedAt : cleanupUpdatedAt,
      });
      if (concurrentEdit === "none") {
        expect(state.cards).toEqual([]);
        expect(state.selectedCardIds.size).toBe(0);
        expect(state.error).toBeNull();
      } else {
        expect(state.cards).toEqual([latest]);
        expect(state.selectedCardIds).toEqual(new Set([child.id]));
        expect(state.error).toContain("Card changed. Review and retry.");
      }
    },
  );

  it.each(["move", "archive", "delete"] as const)(
    "stops bulk %s on a newer card revision and retains it for retry",
    async (action) => {
      const [first, second] = cardPair();
      const newer = { ...second, title: "Changed elsewhere", updatedAt: second.updatedAt + 10 };
      const pending = createDeferred<unknown>();
      const request = vi
        .fn()
        .mockReturnValueOnce(pending.promise)
        .mockRejectedValue(conflict(newer));
      const view = bulkView([first, second], { client: { request } });
      const { get, state, container, renderView } = view;
      if (action === "move") {
        get<SelectPicker>(".workboard-selection [data-test-select-picker]").onSelect("done");
      } else {
        requireButton(container, action === "archive" ? "Archive" : "Delete").click();
        if (action === "delete") {
          setWorkboardCards(state, [first, newer]);
          renderView();
          confirmDelete(view);
        }
      }
      await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
      // Refresh while processing the first card must not replace the observed revision.
      setWorkboardCards(state, [first, newer]);
      pending.resolve(
        action === "delete"
          ? { deleted: true }
          : {
              card: {
                ...first,
                status: action === "move" ? "done" : first.status,
                metadata:
                  action === "archive" ? { archivedAt: first.updatedAt + 1 } : first.metadata,
              },
            },
      );
      await vi.waitFor(() => expect(state.bulkSaving).toBe(false));
      expect(request).toHaveBeenCalledTimes(2);
      expect(request).toHaveBeenNthCalledWith(
        2,
        `workboard.cards.${action}`,
        expect.objectContaining({ id: second.id, expectedUpdatedAt: second.updatedAt }),
      );
      expect(state.cards.find((card) => card.id === second.id)).toEqual(newer);
      expect(state.selectedCardIds).toEqual(new Set([second.id]));
      expect(state.error).toContain("Card changed. Review and retry.");
    },
  );

  it("highlights only the current drag destination and clears it on exit", () => {
    const { find, all, state, renderView } = createWorkboardView({ canWrite: true });
    state.cards = [createWorkboardCard({ title: "Drag feedback" })];
    state.draggedCardId = "card-1";
    renderView();
    expect(find(".workboard-card")?.classList).toContain("workboard-card--dragging");
    expect(find(".workboard-column--drop-target")).toBeNull();
    const running = find(".workboard-column--running")!;
    const todo = find(".workboard-column--todo")!;
    running.dispatchEvent(new Event("dragover", { bubbles: true, cancelable: true }));
    renderView();
    expect(all(".workboard-column--drop-target")).toHaveLength(1);
    expect(running.classList).toContain("workboard-column--drop-target");
    todo.dispatchEvent(new Event("dragover", { bubbles: true, cancelable: true }));
    renderView();
    expect(all(".workboard-column--drop-target")).toHaveLength(1);
    expect(todo.classList).toContain("workboard-column--drop-target");
    todo.dispatchEvent(new MouseEvent("dragleave", { relatedTarget: todo.firstElementChild }));
    expect(state.dragOverStatus).toBe("todo");
    todo.dispatchEvent(new Event("dragleave"));
    renderView();
    expect(find(".workboard-column--drop-target")).toBeNull();
    running.dispatchEvent(new Event("dragover", { bubbles: true, cancelable: true }));
    find(".workboard-card")!.dispatchEvent(new Event("dragend"));
    renderView();
    expect(state).toMatchObject({ draggedCardId: null, dragOverStatus: null });
    expect(find(".workboard-card--dragging")).toBeNull();
    expect(find(".workboard-column--drop-target")).toBeNull();
  });

  it.each(["readiness", "permission"] as const)("hides card mutations without %s", (reason) => {
    const { find, all, host, state, container, renderView } = createWorkboardView(
      reason === "permission" ? { canWrite: false } : {},
    );
    state.cards = [createWorkboardCard({ title: "Inspect only" })];
    if (reason === "readiness") {
      resetWorkboardConnectionState(host);
    }
    renderView();
    expect(buttonByLabel(container, "Edit card")).toBeNull();
    expect(find(".workboard-card")?.getAttribute("draggable")).toBe("false");
    if (reason === "readiness") {
      expect(buttonByLabel(container, "Archive card")).toBeNull();
      expect(buttonByText(container, "New card")).toBeNull();
      state.mutationReadiness = "ready";
      renderView();
      expect(buttonByLabel(container, "Edit card")).not.toBeNull();
      expect(buttonByText(container, "New card")).not.toBeNull();
    } else {
      expect(buttonByLabel(container, "Delete card")).toBeNull();
      expect(all<HTMLButtonElement>(".workboard-card__start")).toHaveLength(0);
      expect(find<HTMLButtonElement>(".workboard-heading__actions .btn.primary")).toBeNull();
      expect(find<HTMLSelectElement>(".workboard-card__move-select")).toBeNull();
      expect(find(".workboard-card")?.getAttribute("role")).toBe("button");
    }
  });

  it("keeps board keyboard selection intact when opening an action from the card menu", () => {
    const { all, state, renderView } = createWorkboardView({ canWrite: true });
    state.viewMode = "board";
    state.cards = [...cardPair({ position: 1000 })];
    renderView();
    const rows = all(".workboard-card");
    const first = expectDefined(rows[0], "first list row");
    const second = expectDefined(rows[1], "second list row");
    expect(first.getAttribute("aria-pressed")).toBeNull();
    expect(second.getAttribute("aria-pressed")).toBeNull();
    key(first, "Enter", true);
    renderView();
    expect(first.getAttribute("aria-pressed")).toBe("true");
    expect(second.getAttribute("aria-pressed")).toBe("false");
    expect(first.getAttribute("aria-haspopup")).toBeNull();
    expect(state.detailCardId).toBeNull();
    key(second, " ");
    renderView();
    expect(state.selectedCardIds).toEqual(new Set(["first", "second"]));
    expect(second.getAttribute("aria-pressed")).toBe("true");
    query<HTMLButtonElement>(second, ".workboard-card__menu-trigger").click();
    expect(state.selectedCardIds).toEqual(new Set(["first", "second"]));
    expect(state.detailCardId).toBeNull();
    requireButton(second, "Edit card").click();
    renderView();
    expect(state).toMatchObject({ draftOpen: true, editingCardId: "second", detailCardId: null });
    expect(state.selectedCardIds).toEqual(new Set(["first", "second"]));
  });

  it("shows unfinished parent dependencies without blocking stale local starts", () => {
    const { find, all, state, renderView } = createWorkboardView();
    state.cards = [...linkedCards("Finish art pass", "Ship game shell")];
    renderView();
    const childCard = [...all(".workboard-card")].find((card) =>
      card.textContent?.includes("Ship game shell"),
    );
    const start = childCard?.querySelector<HTMLButtonElement>(".workboard-card__start");
    expect(childCard?.textContent).toContain("1 blocked");
    expect(start?.disabled).toBe(false);
    expect(start?.getAttribute("aria-label")).toBe("Run default agent");
    requireButton(expectDefined(childCard, "child card"), "View details").click();
    renderView();
    const detail = find(".workboard-detail");
    expect(detail?.textContent).toContain("Dependencies");
    expect(detail?.textContent).toContain("Finish art pass");
    expect(detail?.textContent).toContain("Todo");
    for (const mode of ["autonomous", "manual"]) {
      const buttons = [
        ...all<HTMLButtonElement>(`.workboard-detail .workboard-card__start--${mode}`),
      ];
      expect(buttons.length).toBeGreaterThan(0);
      expect(buttons.every((button) => button.disabled)).toBe(false);
    }
  });

  it("restricts model-specific starts for non-admins", () => {
    const { find, all, state, renderView } = createWorkboardView({ canModelOverride: false });
    state.cards = [createWorkboardCard()];
    renderView();
    const startButtons = [...all<HTMLButtonElement>(".workboard-card__start")];
    expect(
      startButtons.map((button) => [button.textContent?.trim(), button.getAttribute("aria-label")]),
    ).toEqual([["Start", "Run default agent"]]);
    find<HTMLButtonElement>('button[aria-label="View details"]')?.click();
    renderView();
    expect(
      [...all(".workboard-detail .workboard-card__start")].map((button) =>
        button.getAttribute("aria-label"),
      ),
    ).toEqual(["Run default agent", "Open OpenAI", "Open Claude"]);
  });

  it("restricts model-specific starts for ACP", () => {
    const { all, state, renderView } = createWorkboardView({
      agentsList: {
        defaultId: "main",
        agents: [{ id: "main", name: "Main", agentRuntime: { id: "codex", source: "agent" } }],
      },
    });
    state.cards = [createWorkboardCard({ agentId: "main" })];
    state.detailCardId = "card-1";
    renderView();
    const buttons = [
      ...all<HTMLButtonElement>(
        ".workboard-detail .workboard-card__start:not(.workboard-card__start--default)",
      ),
    ];
    expect(buttons).toHaveLength(4);
    expect(buttons.every((button) => button.disabled)).toBe(true);
    expect(buttons[0]?.getAttribute("aria-label")).toContain("uses the codex ACP runtime");
  });

  it.each(["drop", "select", "keyboard", "busy"] as const)(
    "handles card status moves through %s",
    async (route) => {
      const { find, state, renderView } = createWorkboardView();
      const movingCard = createWorkboardCard(
        route === "select" ? { metadata: { automation: { boardId: "ops" } } } : {},
      );
      state.cards = [movingCard];
      if (route === "select") {
        state.boardFilter = "ops";
        state.cards.push(
          createWorkboardCard({
            id: "archived-ops-running",
            status: "running",
            position: 3000,
            metadata: { archivedAt: 10, automation: { boardId: "ops" } },
          }),
          createWorkboardCard({
            id: "product-running",
            status: "running",
            position: 9000,
            metadata: { automation: { boardId: "product" } },
          }),
        );
      } else if (route === "drop") {
        state.viewMode = "list";
        state.draggedCardId = movingCard.id;
      } else if (route === "busy") {
        state.busyCardIds.add(movingCard.id);
      }
      const status = route === "keyboard" ? "scheduled" : "running";
      const position = route === "select" ? 4000 : 1000;
      const moved = {
        ...movingCard,
        status,
        position,
        updatedAt: route === "keyboard" ? 2 : movingCard.updatedAt,
      };
      const request = vi.fn();
      if (route !== "busy") {
        request.mockResolvedValue({ card: moved });
      }
      renderView({ client: { request } });
      if (route === "drop") {
        find(".workboard-column--running")?.dispatchEvent(
          new Event("drop", { bubbles: true, cancelable: true }),
        );
      } else {
        const moveSelect = find<HTMLSelectElement>(".workboard-card__move-select");
        expect(moveSelect).not.toBeNull();
        if (route === "select" || route === "busy") {
          if (route === "busy") {
            expect(moveSelect?.disabled).toBe(true);
          }
          moveSelect!.value = route === "busy" ? "blocked" : status;
          moveSelect!.dispatchEvent(new Event("change", { bubbles: true }));
        }
        if (route === "keyboard" || route === "busy") {
          expect(key(moveSelect!, "ArrowRight")).toBe(false);
        }
      }
      await Promise.resolve();
      await Promise.resolve();
      if (route === "busy") {
        expect(request).not.toHaveBeenCalled();
        expect(state.cards[0]).toMatchObject({ status: "todo", updatedAt: 1 });
      } else {
        expect(request).toHaveBeenCalledWith("workboard.cards.move", {
          id: movingCard.id,
          status,
          position,
        });
        if (route === "keyboard") {
          expect(state.cards[0]).toMatchObject({ status: "scheduled", updatedAt: 2 });
        } else {
          expect(state.cards).toContainEqual(moved);
        }
      }
    },
  );
});
