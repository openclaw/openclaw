import "../../test/dom.setup.ts";
import { GatewayProtocolRequestError } from "@openclaw/gateway-client/browser";
import { expectDefined } from "@openclaw/normalization-core";
import { createDeferred } from "openclaw/plugin-sdk/concurrency-runtime";
import { flush } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import { replaceCard, setWorkboardCards } from "../../lib/workboard/card-state.ts";
import { notifyWorkboard, resetWorkboardConnectionState } from "../../lib/workboard/runtime.ts";
import { createWorkboardCard } from "../../lib/workboard/test/index-helpers.ts";
import { workboardTestHost } from "../../test/host.setup.ts";
import { waitForFast } from "../../test/wait-for.ts";
import {
  type SelectPicker,
  createWorkboardView,
  buttonByLabel,
  buttonByText,
  requireButton,
  openCardMenu,
} from "./view.test-support.ts";

describe("WorkboardView", () => {
  it.each(["board", "list"] as const)(
    "returns focus to a visible selected card in the same %s view when clearing selection",
    (viewMode) => {
      const other = createWorkboardView({ canWrite: true });
      const current = createWorkboardView({ canWrite: true });
      for (const view of [other, current]) {
        view.state.viewMode = viewMode;
        view.state.cards = [
          createWorkboardCard({ id: "collapsed", status: "todo" }),
          createWorkboardCard({ id: "unselected", status: "running" }),
          createWorkboardCard({ id: "selected", status: "running", position: 2000 }),
        ];
        view.state.selectedCardIds = new Set(["collapsed", "selected"]);
        view.renderView();
      }
      current.state.collapsedStatuses.add("todo");
      current.renderView();
      const selected = expectDefined(
        current.container.querySelector<HTMLElement>(".workboard-card--selected"),
        "visible selected card",
      );
      const clear = requireButton(current.container, "Clear selection");
      clear.focus();
      clear.click();
      current.renderView();
      expect(current.state.selectedCardIds.size).toBe(0);
      expect(current.container.querySelector(".workboard-selection")).toBeNull();
      expect(document.activeElement).toBe(selected);
      expect(other.state.selectedCardIds).toEqual(new Set(["collapsed", "selected"]));
    },
  );

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

  it("places variable-height card drops without measuring unrelated rows", async () => {
    const request = vi.fn().mockResolvedValue({
      card: createWorkboardCard({ id: "dragged", position: 1500 }),
    });
    const { state, container, renderView } = createWorkboardView({
      canWrite: true,
      client: { request },
    });
    state.viewMode = "board";
    state.cards = ["first", "second", "dragged", "last"].map((id, index) =>
      createWorkboardCard({ id, position: (index + 1) * 1000 }),
    );
    state.draggedCardId = "dragged";
    renderView();
    const column = expectDefined(container.querySelector(".workboard-column--todo"), "todo column");
    const row = (id: string) =>
      expectDefined(
        column.querySelector<HTMLElement>(`.workboard-column__item[data-card-id="${id}"]`),
        id,
      );
    const measurements = [
      { id: "first", top: 0, height: 40 },
      { id: "second", top: 52, height: 120 },
      { id: "dragged", top: 184, height: 80 },
      { id: "last", top: 276, height: 60 },
    ].map(({ id, top, height }) =>
      vi.spyOn(row(id), "getBoundingClientRect").mockReturnValue(new DOMRect(0, top, 240, height)),
    );
    const secondTitle = expectDefined(row("second").querySelector("h3"), "second title");
    const hover = (target: Element, clientY: number, beforeId: string | null, reads: number) => {
      measurements.forEach((measurement) => measurement.mockClear());
      target.dispatchEvent(
        new MouseEvent("dragover", { bubbles: true, cancelable: true, clientY }),
      );
      expect(state.dragBeforeCardId).toBe(beforeId);
      expect(
        measurements.reduce((count, measurement) => count + measurement.mock.calls.length, 0),
      ).toBeLessThanOrEqual(reads);
      renderView();
      const marker = column.querySelector(
        ".workboard-column__item--drop-before, .workboard-column__item--drop-after",
      );
      expect(marker?.getAttribute("data-card-id")).toBe(beforeId ?? "last");
    };
    hover(secondTitle, 111, "second", 1);
    hover(secondTitle, 112, "last", 1);
    hover(
      expectDefined(column.querySelector(".workboard-column__cards"), "cards"),
      45,
      "second",
      2,
    );
    hover(expectDefined(row("dragged").querySelector("h3"), "dragged title"), 190, "last", 0);
    hover(row("first"), 19, "first", 1);
    hover(row("last"), 306, null, 1);
    measurements.forEach((measurement) => measurement.mockClear());
    secondTitle.dispatchEvent(
      new MouseEvent("drop", { bubbles: true, cancelable: true, clientY: 111 }),
    );
    expect(
      measurements.reduce((count, measurement) => count + measurement.mock.calls.length, 0),
    ).toBeLessThanOrEqual(1);
    await waitForFast(() => {
      expect(request).toHaveBeenCalledWith("workboard.cards.move", {
        id: "dragged",
        status: "todo",
        position: 1500,
      });
      expect(state.cards.find((card) => card.id === "dragged")?.position).toBe(1500);
    });
    expect(state.draggedCardId).toBeNull();
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
      expect(buttonByLabel(openCardMenu(container), "Edit card")).not.toBeNull();
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
    expect(second.querySelector(".workboard-card__action-menu-panel")).toBeNull();
    const panel = openCardMenu(second);
    const firstAction = requireButton(panel, "Edit card");
    expect(state.selectedCardIds).toEqual(new Set(["first", "second"]));
    expect(state.detailCardId).toBeNull();
    panel.dispatchEvent(
      Object.assign(new Event("beforetoggle"), { oldState: "open", newState: "closed" }),
    );
    flush();
    expect(requireButton(panel, "Edit card")).toBe(firstAction);
    expect(openCardMenu(first)).toBe(panel);
    expect(openCardMenu(second)).toBe(panel);
    expect(requireButton(panel, "Edit card")).toBe(firstAction);
    firstAction.click();
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
    const menu = openCardMenu(expectDefined(childCard, "dependent card"));
    const start = menu.querySelector<HTMLButtonElement>(".workboard-card__start");
    expect(childCard?.textContent).toContain("1 blocked");
    expect(start?.disabled).toBe(false);
    expect(start?.getAttribute("aria-label")).toBe("Run default agent");
    requireButton(menu, "View details").click();
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

  it("refreshes retained child dependencies when parents or window completeness change", () => {
    const { host, state, container, renderView } = createWorkboardView();
    const parent = createWorkboardCard({ id: "parent", title: "Parent draft" });
    const child = createWorkboardCard({
      id: "child",
      title: "Dependent child",
      position: 2000,
      metadata: {
        links: [{ id: "parent-link", type: "parent", targetCardId: "parent", createdAt: 1 }],
      },
    });
    setWorkboardCards(state, [parent, child]);
    renderView();
    const childRow = expectDefined(
      container.querySelector<HTMLElement>('[data-card-id="child"] .workboard-card'),
      "dependent card",
    );
    expect(childRow.textContent).toContain("1 blocked");
    childRow.click();
    renderView();
    const dependencies = expectDefined(
      container.querySelector(".workboard-detail__dependencies"),
      "dependency details",
    );
    expect(dependencies.textContent).toContain("Parent draft");
    expect(dependencies.textContent).toContain("Todo");
    replaceCard(state, { ...parent, title: "Parent complete", status: "done", updatedAt: 2 });
    notifyWorkboard(host);
    flush();
    expect(state.cards.find((card) => card.id === "child")).toBe(child);
    expect(container.querySelector('[data-card-id="child"] .workboard-card')).toBe(childRow);
    expect(childRow.querySelector(".workboard-card__alert")).toBeNull();
    expect(dependencies.textContent).toContain("Parent complete");
    expect(dependencies.textContent).toContain("Done");
    expect(dependencies.querySelector("li")?.classList.contains("is-done")).toBe(true);

    setWorkboardCards(state, [child]);
    state.nextCursor = { id: child.id, position: child.position, createdAt: child.createdAt };
    notifyWorkboard(host);
    flush();
    expect(dependencies.textContent).toContain("Not loaded");
    expect(dependencies.querySelector(".is-blocked")).toBeNull();
    expect(childRow.querySelector(".workboard-card__alert")).toBeNull();
    const partialCards = state.cards;
    state.nextCursor = null;
    notifyWorkboard(host);
    flush();
    expect(state.cards).toBe(partialCards);
    expect(container.querySelector('[data-card-id="child"] .workboard-card')).toBe(childRow);
    expect(dependencies.textContent).toContain("Missing");
    expect(dependencies.querySelectorAll(".is-blocked")).toHaveLength(1);
    expect(childRow.textContent).toContain("1 blocked");
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
        const menu = openCardMenu(container);
        const startButtons = [
          ...menu.querySelectorAll<HTMLButtonElement>(".workboard-card__start"),
        ];
        expect(startButtons.map((button) => button.textContent?.trim())).toEqual(["Start"]);
        expect(startButtons.map((button) => button.getAttribute("aria-label"))).toEqual([
          "Run default agent",
        ]);
        requireButton(menu, "View details").click();
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
      const moveSelect = openCardMenu(container).querySelector<HTMLSelectElement>(
        ".workboard-card__move-select",
      );
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
        if (route === "keyboard") {
          expect(dispatched).toBe(false);
        }
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
