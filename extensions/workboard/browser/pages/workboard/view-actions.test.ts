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
  type SelectPicker,
  createWorkboardView,
  buttonByLabel,
  buttonByText,
  requireButton,
} from "./view.test-support.ts";

describe("WorkboardView", () => {
  it("retries only pending bulk edits after the second card fails", async () => {
    const first = createWorkboardCard({ id: "first", agentId: "writer" });
    const second = createWorkboardCard({ id: "second", agentId: "writer", position: 2000 });
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        card: { ...first, agentId: "main", updatedAt: first.updatedAt + 1 },
      })
      .mockRejectedValueOnce(new Error("Second card update rejected"))
      .mockResolvedValueOnce({
        card: { ...second, agentId: "main", updatedAt: second.updatedAt + 1 },
      });
    const { state, container, renderView } = createWorkboardView({
      client: { request },
      connected: true,
      canWrite: true,
      agentsList: { defaultId: "main", agents: [{ id: "main" }, { id: "writer" }] },
    });
    state.cards = [first, second];
    state.selectedCardIds = new Set([first.id, second.id]);
    renderView();
    requireButton(container, "Edit properties").click();
    renderView();
    const picker = expectDefined(
      container.querySelector<SelectPicker>(".workboard-bulk-dialog [data-test-select-picker]"),
      ".workboard-bulk-dialog [data-test-select-picker]",
    );
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
      const errorToast = container.querySelector("openclaw-workboard-toast:not([hidden])");
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
    expect(state.bulkDialog).toBeNull();
    expect(state.bulkResult).toEqual({ completed: 1, total: 1 });
    expect(state.error).toBeNull();
  });

  it.each(["write revocation", "disconnect", "activation disposal"] as const)(
    "stops a bulk assignment after %s changes while the first write is pending",
    async (change) => {
      const first = createWorkboardCard({ id: "first", agentId: "writer" });
      const second = createWorkboardCard({ id: "second", agentId: "writer", position: 2000 });
      const firstWrite = createDeferred<{ card: typeof first }>();
      const request = vi
        .fn()
        .mockImplementationOnce(() => firstWrite.promise)
        .mockResolvedValue({ card: { ...second, agentId: "main" } });
      const { state, container, renderView } = createWorkboardView({
        client: { request },
        connected: true,
        canWrite: true,
        agentsList: { defaultId: "main", agents: [{ id: "main" }, { id: "writer" }] },
      });
      state.cards = [first, second];
      state.selectedCardIds = new Set([first.id, second.id]);
      renderView();
      const picker = expectDefined(
        [
          ...container.querySelectorAll<SelectPicker>(
            ".workboard-selection [data-test-select-picker]",
          ),
        ].find((item) => item.accessibleLabel === "Assign agent…"),
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
    const first = createWorkboardCard({ id: "first" });
    const second = createWorkboardCard({ ...first, id: "second", position: 2000 });
    const outside = { ...second, metadata: { archivedAt: second.updatedAt + 1 } };
    const pending = createDeferred<{ deleted: boolean }>();
    const request = vi
      .fn()
      .mockImplementationOnce(() => pending.promise)
      .mockResolvedValue({ deleted: true });
    const { state, container, renderView } = createWorkboardView({
      client: { request },
      canWrite: true,
    });
    state.cards = [first, second];
    state.selectedCardIds = new Set([first.id, second.id]);
    renderView();
    expectDefined(
      container.querySelector<HTMLButtonElement>(".workboard-selection__delete"),
      ".workboard-selection__delete",
    ).click();
    renderView();
    expect(state.bulkDialog?.cardIds).toEqual([first.id, second.id]);
    expectDefined(
      container.querySelector<HTMLButtonElement>('.workboard-bulk-dialog button[type="submit"]'),
      '.workboard-bulk-dialog button[type="submit"]',
    ).click();
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    setWorkboardCards(state, [first, outside]);
    pending.resolve({ deleted: true });
    await vi.waitFor(() => expect(state.bulkSaving).toBe(false));
    expect(request).toHaveBeenCalledTimes(1);
    expect(state.cards.find((card) => card.id === second.id)).toEqual(outside);
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
      const parent = createWorkboardCard({ id: "parent" });
      const child = createWorkboardCard({
        id: "child",
        position: 2000,
        metadata: {
          links: [{ id: "link", type: "parent", targetCardId: parent.id, createdAt: 1 }],
        },
      });
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
          throw new GatewayProtocolRequestError({
            code: "workboard_conflict",
            message: "Card changed. Review and retry.",
            details: { type: "workboard_card_conflict", card: latest },
          });
        }
        return { deleted: true };
      });
      const { state, container, renderView } = createWorkboardView({
        client: { request },
        canWrite: true,
      });
      state.cards = [parent, child];
      state.selectedCardIds = new Set([parent.id, child.id]);
      renderView();
      expectDefined(
        container.querySelector<HTMLButtonElement>(".workboard-selection__delete"),
        ".workboard-selection__delete",
      ).click();
      renderView();
      expectDefined(
        container.querySelector<HTMLButtonElement>('.workboard-bulk-dialog button[type="submit"]'),
        '.workboard-bulk-dialog button[type="submit"]',
      ).click();
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
      const first = createWorkboardCard({ id: "first" });
      const second = createWorkboardCard({ id: "second", position: 2000 });
      const newer = { ...second, title: "Changed elsewhere", updatedAt: second.updatedAt + 10 };
      const pending = createDeferred<unknown>();
      const request = vi
        .fn()
        .mockImplementationOnce(() => pending.promise)
        .mockImplementation(async () => {
          throw new GatewayProtocolRequestError({
            code: "workboard_conflict",
            message: "Card changed. Review and retry.",
            details: { type: "workboard_card_conflict", card: newer },
          });
        });
      const { state, container, renderView } = createWorkboardView({
        client: { request },
        canWrite: true,
      });
      state.cards = [first, second];
      state.selectedCardIds = new Set([first.id, second.id]);
      renderView();
      if (action === "move") {
        expectDefined(
          container.querySelector<SelectPicker>(".workboard-selection [data-test-select-picker]"),
          ".workboard-selection [data-test-select-picker]",
        ).onSelect("done");
      } else {
        requireButton(container, action === "archive" ? "Archive" : "Delete").click();
        if (action === "delete") {
          setWorkboardCards(state, [first, newer]);
          renderView();
          expectDefined(
            container.querySelector<HTMLButtonElement>(
              '.workboard-bulk-dialog button[type="submit"]',
            ),
            '.workboard-bulk-dialog button[type="submit"]',
          ).click();
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
    const { state, container, renderView } = createWorkboardView({ canWrite: true });
    state.cards = [createWorkboardCard({ title: "Drag feedback" })];
    state.draggedCardId = "card-1";
    renderView();
    expect(container.querySelector(".workboard-card")?.classList).toContain(
      "workboard-card--dragging",
    );
    expect(container.querySelector(".workboard-column--drop-target")).toBeNull();
    const running = container.querySelector(".workboard-column--running")!;
    const todo = container.querySelector(".workboard-column--todo")!;
    running.dispatchEvent(new Event("dragover", { bubbles: true, cancelable: true }));
    renderView();
    expect(container.querySelectorAll(".workboard-column--drop-target")).toHaveLength(1);
    expect(running.classList).toContain("workboard-column--drop-target");
    todo.dispatchEvent(new Event("dragover", { bubbles: true, cancelable: true }));
    renderView();
    expect(container.querySelectorAll(".workboard-column--drop-target")).toHaveLength(1);
    expect(todo.classList).toContain("workboard-column--drop-target");
    todo.dispatchEvent(new MouseEvent("dragleave", { relatedTarget: todo.firstElementChild }));
    expect(state.dragOverStatus).toBe("todo");
    todo.dispatchEvent(new Event("dragleave"));
    renderView();
    expect(container.querySelector(".workboard-column--drop-target")).toBeNull();
    running.dispatchEvent(new Event("dragover", { bubbles: true, cancelable: true }));
    container.querySelector(".workboard-card")!.dispatchEvent(new Event("dragend"));
    renderView();
    expect(state.draggedCardId).toBeNull();
    expect(state.dragOverStatus).toBeNull();
    expect(container.querySelector(".workboard-card--dragging")).toBeNull();
    expect(container.querySelector(".workboard-column--drop-target")).toBeNull();
  });

  it.each(["readiness", "permission"] as const)("hides card mutations without %s", (reason) => {
    const { host, state, container, renderView } = createWorkboardView(
      reason === "permission" ? { canWrite: false } : {},
    );
    state.cards = [createWorkboardCard({ title: "Inspect only" })];
    if (reason === "readiness") {
      resetWorkboardConnectionState(host);
    }
    renderView();
    expect(buttonByLabel(container, "Edit card")).toBeNull();
    expect(container.querySelector(".workboard-card")?.getAttribute("draggable")).toBe("false");
    if (reason === "readiness") {
      expect(buttonByLabel(container, "Archive card")).toBeNull();
      expect(buttonByText(container, "New card")).toBeNull();
      state.mutationReadiness = "ready";
      renderView();
      expect(buttonByLabel(container, "Edit card")).not.toBeNull();
      expect(buttonByText(container, "New card")).not.toBeNull();
    } else {
      expect(buttonByLabel(container, "Delete card")).toBeNull();
      expect(container.querySelectorAll<HTMLButtonElement>(".workboard-card__start")).toHaveLength(
        0,
      );
      expect(
        container.querySelector<HTMLButtonElement>(".workboard-heading__actions .btn.primary"),
      ).toBeNull();
      expect(container.querySelector<HTMLSelectElement>(".workboard-card__move-select")).toBeNull();
      expect(container.querySelector(".workboard-card")?.getAttribute("role")).toBe("button");
    }
  });

  it("keeps board keyboard selection intact when opening an action from the card menu", () => {
    const { state, container, renderView } = createWorkboardView({ canWrite: true });
    state.viewMode = "board";
    state.cards = [
      createWorkboardCard({ id: "first", title: "First row" }),
      createWorkboardCard({ id: "second", title: "Second row" }),
    ];
    renderView();
    const rows = container.querySelectorAll<HTMLElement>(".workboard-card");
    const first = expectDefined(rows[0], "first list row");
    const second = expectDefined(rows[1], "second list row");
    expect(first.getAttribute("aria-pressed")).toBeNull();
    expect(second.getAttribute("aria-pressed")).toBeNull();
    first.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    renderView();
    expect(first.getAttribute("aria-pressed")).toBe("true");
    expect(second.getAttribute("aria-pressed")).toBe("false");
    expect(first.getAttribute("aria-haspopup")).toBeNull();
    expect(state.detailCardId).toBeNull();
    second.dispatchEvent(
      new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true }),
    );
    renderView();
    expect(state.selectedCardIds).toEqual(new Set(["first", "second"]));
    expect(second.getAttribute("aria-pressed")).toBe("true");
    expectDefined(
      second.querySelector<HTMLButtonElement>(".workboard-card__menu-trigger"),
      ".workboard-card__menu-trigger",
    ).click();
    expect(state.selectedCardIds).toEqual(new Set(["first", "second"]));
    expect(state.detailCardId).toBeNull();
    requireButton(second, "Edit card").click();
    renderView();
    expect(state.draftOpen).toBe(true);
    expect(state.editingCardId).toBe("second");
    expect(state.detailCardId).toBeNull();
    expect(state.selectedCardIds).toEqual(new Set(["first", "second"]));
  });

  it("shows unfinished parent dependencies without blocking stale local starts", () => {
    const { state, container, renderView } = createWorkboardView({
      onRequestUpdate: () => undefined,
    });
    state.cards = [
      createWorkboardCard({ id: "parent-1", title: "Finish art pass" }),
      createWorkboardCard({
        id: "child-1",
        title: "Ship game shell",
        position: 2000,
        metadata: {
          links: [{ id: "link-1", type: "parent", targetCardId: "parent-1", createdAt: 1 }],
        },
      }),
    ];
    renderView();
    const childCard = [...container.querySelectorAll<HTMLElement>(".workboard-card")].find((card) =>
      card.textContent?.includes("Ship game shell"),
    );
    const start = childCard?.querySelector<HTMLButtonElement>(".workboard-card__start");
    expect(childCard?.textContent).toContain("1 blocked");
    expect(start?.disabled).toBe(false);
    expect(start?.getAttribute("aria-label")).toBe("Run default agent");
    childCard
      ?.querySelector<HTMLButtonElement>('button[aria-label="View details"]')
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    renderView();
    const detail = container.querySelector(".workboard-detail");
    expect(detail?.textContent).toContain("Dependencies");
    expect(detail?.textContent).toContain("Finish art pass");
    expect(detail?.textContent).toContain("Todo");
    const detailRunButtons = [
      ...container.querySelectorAll<HTMLButtonElement>(
        ".workboard-detail .workboard-card__start--autonomous",
      ),
    ];
    const detailOpenButtons = [
      ...container.querySelectorAll<HTMLButtonElement>(
        ".workboard-detail .workboard-card__start--manual",
      ),
    ];
    expect(detailRunButtons.length).toBeGreaterThan(0);
    expect(detailRunButtons.every((button) => button.disabled)).toBe(false);
    expect(detailOpenButtons.length).toBeGreaterThan(0);
    expect(detailOpenButtons.every((button) => button.disabled)).toBe(false);
  });

  it.each(["non-admin", "ACP"] as const)(
    "restricts model-specific starts for %s",
    (restriction) => {
      const { state, container, renderView } = createWorkboardView(
        restriction === "non-admin"
          ? { canModelOverride: false }
          : {
              agentsList: {
                defaultId: "main",
                agents: [
                  { id: "main", name: "Main", agentRuntime: { id: "codex", source: "agent" } },
                ],
              },
            },
      );
      state.cards = [
        createWorkboardCard(
          restriction === "non-admin"
            ? { title: "Start with default model" }
            : { title: "ACP-backed work", agentId: "main" },
        ),
      ];
      if (restriction === "non-admin") {
        renderView();
        const startButtons = [
          ...container.querySelectorAll<HTMLButtonElement>(".workboard-card__start"),
        ];
        expect(startButtons.map((button) => button.textContent?.trim())).toEqual(["Start"]);
        expect(startButtons.map((button) => button.getAttribute("aria-label"))).toEqual([
          "Run default agent",
        ]);
        container
          .querySelector<HTMLButtonElement>('button[aria-label="View details"]')
          ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      } else {
        state.detailCardId = "card-1";
      }
      renderView();
      const detailStartButtons = [
        ...container.querySelectorAll<HTMLButtonElement>(
          `.workboard-detail .workboard-card__start${restriction === "ACP" ? ":not(.workboard-card__start--default)" : ""}`,
        ),
      ];
      if (restriction === "non-admin") {
        expect(detailStartButtons.map((button) => button.getAttribute("aria-label"))).toEqual([
          "Run default agent",
          "Open OpenAI",
          "Open Claude",
        ]);
      } else {
        expect(detailStartButtons).toHaveLength(4);
        expect(detailStartButtons.every((button) => button.disabled)).toBe(true);
        expect(detailStartButtons[0]?.getAttribute("aria-label")).toContain(
          "uses the codex ACP runtime",
        );
      }
    },
  );

  it.each([
    { route: "drop", title: "Fallback drag move" },
    { route: "select", title: "Move within Operations" },
    { route: "keyboard", title: "Keyboard arrow move" },
    { route: "busy", title: "Busy move" },
  ] as const)("handles card status moves through $route", async ({ route, title }) => {
    const { state, container, renderView } = createWorkboardView();
    const movingCard = createWorkboardCard({
      title,
      ...(route === "select" ? { metadata: { automation: { boardId: "ops" } } } : {}),
    });
    state.cards = [movingCard];
    if (route === "select") {
      state.boardFilter = "ops";
      state.cards.push(
        createWorkboardCard({
          id: "archived-ops-running",
          title: "Archived Operations run",
          status: "running",
          position: 3000,
          metadata: { archivedAt: 10, automation: { boardId: "ops" } },
        }),
        createWorkboardCard({
          id: "product-running",
          title: "Unrelated Product run",
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
      container
        .querySelector(".workboard-column--running")
        ?.dispatchEvent(new Event("drop", { bubbles: true, cancelable: true }));
    } else {
      const moveSelect = container.querySelector<HTMLSelectElement>(".workboard-card__move-select");
      expect(moveSelect).not.toBeNull();
      if (route === "select" || route === "busy") {
        if (route === "busy") {
          expect(moveSelect?.disabled).toBe(true);
        }
        moveSelect!.value = route === "busy" ? "blocked" : status;
        moveSelect!.dispatchEvent(new Event("change", { bubbles: true }));
      }
      if (route === "keyboard" || route === "busy") {
        const dispatched = moveSelect!.dispatchEvent(
          new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }),
        );
        expect(dispatched).toBe(false);
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
  });
});
