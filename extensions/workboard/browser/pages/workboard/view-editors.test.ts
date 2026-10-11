import "../../test/dom.setup.ts";
import { GatewayProtocolRequestError } from "@openclaw/gateway-client/browser";
import { expectDefined } from "@openclaw/normalization-core";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { flush } from "solid-js";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { resetWorkboardConnectionState } from "../../lib/workboard/index.ts";
import {
  createGatewaySession,
  createWorkboardCard,
  createWorkboardTestClient,
} from "../../lib/workboard/test/index-helpers.ts";
import { waitForFast } from "../../test/wait-for.ts";
import {
  createLoadedWorkboardState,
  createWorkboardRenderProps,
  renderInto,
  createWorkboardView,
  buttonByLabel,
  buttonByText,
  requireButton,
  textButton,
  inlineEditor,
  sessionPicker,
  toast,
} from "./view.test-support.ts";

describe("WorkboardView", () => {
  it("keeps a stale edit draft disabled until it is cancelled", async () => {
    const { host, state, container, renderView } = createWorkboardView();
    state.cards = [createWorkboardCard({ title: "Canonical title" })];
    state.draftOpen = true;
    state.editingCardId = "card-1";
    state.draftTitle = "Unsaved edit";
    resetWorkboardConnectionState(host);
    renderView();
    state.mutationReadiness = "stale_edit_draft";
    renderView();
    expect(
      container.querySelector<HTMLButtonElement>(".workboard-modal__actions .primary")?.disabled,
    ).toBe(true);
    expect(container.querySelector<HTMLInputElement>(".workboard-draft__title")?.value).toBe(
      "Unsaved edit",
    );
    const cancelButton = container.querySelector<HTMLButtonElement>('button[aria-label="Cancel"]');
    expect(cancelButton?.disabled).toBe(false);
    cancelButton?.click();
    expect(state.draftOpen).toBe(false);
  });

  it("passes dialog labels and cancellation back to the plugin draft owner", async () => {
    const { host, state } = createLoadedWorkboardState();
    state.lastDispatchSummary = {
      started: 0,
      failures: 0,
      promoted: 0,
      blocked: 0,
      reclaimed: 0,
      orchestrated: 0,
    };
    state.draftOpen = true;
    state.draftTitle = "Unsaved task";
    const container = document.createElement("div");
    const props = createWorkboardRenderProps(host, {
      onRequestUpdate: () => renderInto(container, props),
    });
    renderInto(container, props);
    expect(
      expectDefined(
        container.querySelector<HTMLElement>(".workboard > openclaw-workboard-toast"),
        ".workboard > openclaw-workboard-toast",
      ).hidden,
    ).toBe(true);
    const dialog = container.querySelector("[data-test-dialog]")!;
    expect(dialog.getAttribute("aria-label")).toBe("New card");
    expect(dialog.getAttribute("aria-description")).toContain("Queue work");
    state.draftSaving = true;
    renderInto(container, props);
    const blocked = new Event("cancel", { cancelable: true });
    dialog.dispatchEvent(blocked);
    expect(blocked.defaultPrevented).toBe(true);
    expect(state.draftOpen).toBe(true);
    state.draftSaving = false;
    renderInto(container, props);
    dialog.dispatchEvent(new Event("cancel", { cancelable: true }));
    expect(state.draftDiscardOpen).toBe(true);
    expect(state.draftOpen).toBe(true);
    textButton(container.querySelector(".workboard-discard")!, "Discard").click();
    expect(state.draftOpen).toBe(false);
    expect(container.querySelector(".workboard-draft")).toBeNull();
    await waitForFast(() =>
      expect(toast(container)?.querySelector("[role=status]")?.textContent?.trim()).toBe(
        "No cards were started.",
      ),
    );
  });

  it("reapplies card templates after editing their text fields", async () => {
    const client = createWorkboardTestClient({
      "workboard.cards.create": { card: createWorkboardCard({ title: "Release: " }) },
    });
    const { state, container, renderView } = createWorkboardView({
      client,
      onRequestUpdate: () => undefined,
    });
    state.draftOpen = true;
    renderView();
    const template = textButton(container, "Release");
    const fields = [
      [".workboard-draft__title", "Release: "],
      [".workboard-draft__notes", "Scope:\nVerification:\nCloseout:"],
      [".workboard-draft__labels", "release"],
    ] as const;
    template.click();
    renderView();
    for (const [selector, value] of fields) {
      const input = expectDefined(
        container.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector),
        selector,
      );
      expect(input.value).toBe(value);
      input.value = `Edited ${value}`;
      input.dispatchEvent(new InputEvent("input", { bubbles: true }));
    }
    template.click();
    renderView();
    for (const [selector, value] of fields) {
      expect(container.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector)?.value).toBe(
        value,
      );
    }
    container
      .querySelector<HTMLFormElement>(".workboard-draft")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await waitForFast(() => expect(state.draftOpen).toBe(false));
    expect(client.request).toHaveBeenCalledExactlyOnceWith(
      "workboard.cards.create",
      expect.objectContaining({
        title: "Release: ",
        notes: "Scope:\nVerification:\nCloseout:",
        labels: ["release"],
        priority: "urgent",
        templateId: "release",
      }),
    );
  });

  it.each(["title", "notes"] as const)(
    "preserves an inline %s draft through lost connectivity and client availability",
    async (field) => {
      const card = createWorkboardCard({
        title: "Original title",
        notes: "Original notes",
        labels: ["original"],
      });
      const value = "Edited text";
      const patch = { [field]: value };
      const client = createWorkboardTestClient(() => ({
        card: { ...card, ...patch, updatedAt: card.updatedAt + 1 },
      }));
      const { state, container, renderView } = createWorkboardView({ client });
      state.cards = [card];
      state.detailCardId = card.id;
      renderView();
      const editor = await inlineEditor(container, field);
      const { owner } = editor;
      const input = await editor.open();
      input.value = value;
      input.dispatchEvent(new InputEvent("input", { bubbles: true }));
      const save = textButton(owner, "Save");
      for (const unavailable of [
        { connected: false, client },
        { connected: true, client: null },
      ]) {
        renderView(unavailable);
        await waitForFast(() => {
          expect(input.disabled).toBe(true);
          expect(save.disabled).toBe(true);
        });
        expect(input.isConnected).toBe(true);
        expect(input.value).toBe(value);
        input.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true }),
        );
        expect(client.request).not.toHaveBeenCalled();
      }
      renderView({ connected: true, client });
      await waitForFast(() => expect(save.disabled).toBe(false));
      expect(input.value).toBe(value);
      save.click();
      await waitForFast(() =>
        expect(client.request).toHaveBeenCalledWith("workboard.cards.update", {
          id: card.id,
          expectedUpdatedAt: card.updatedAt,
          patch,
        }),
      );
      await waitForFast(() => expect(state.cards[0]).toMatchObject(patch));
    },
  );

  it("keeps notes selectable and opens the editor only on a plain click", async () => {
    const card = createWorkboardCard({ notes: "Copy me" });
    const { state, container, renderView } = createWorkboardView({
      client: createWorkboardTestClient({}),
    });
    state.cards = [card];
    state.detailCardId = card.id;
    renderView();
    const { trigger, owner, open } = await inlineEditor(container, "notes");
    const selection = expectDefined(document.getSelection(), "selection");
    selection.selectAllChildren(trigger);
    trigger.click();
    flush();
    expect(owner.querySelector("textarea")).toBeNull();
    selection.removeAllRanges();
    const textarea = await open();
    expect(textarea.value).toBe("Copy me");
  });

  it("resumes dirty labels after light dismissal and clears them only on explicit cancel", async () => {
    const card = createWorkboardCard({ labels: ["original"] });
    const { state, container, renderView } = createWorkboardView({
      client: createWorkboardTestClient({}),
    });
    state.cards = [card];
    state.detailCardId = card.id;
    renderView();
    const editor = await inlineEditor(container, "labels");
    const { trigger } = editor;
    const popup = expectDefined(editor.popover, "labels popover");
    const matches = vi.spyOn(popup, "matches").mockReturnValue(false);
    onTestFinished(() => matches.mockRestore());
    const input = await editor.open();
    input.value = "original, pending";
    input.dispatchEvent(new InputEvent("input", { bubbles: true }));
    popup.dispatchEvent(new Event("toggle"));
    await waitForFast(() => expect(popup.querySelector("input")).toBeNull());
    trigger.click();
    await waitForFast(() =>
      expect(popup.querySelector<HTMLInputElement>("input")?.value).toBe("original, pending"),
    );
    textButton(popup, "Cancel").click();
    await waitForFast(() => expect(popup.querySelector("input")).toBeNull());
    trigger.click();
    await waitForFast(() =>
      expect(popup.querySelector<HTMLInputElement>("input")?.value).toBe("original"),
    );
    expect(state.cards[0]?.labels).toEqual(["original"]);
  });

  it.each([
    { field: "title", change: "permission", dismiss: "none" },
    { field: "notes", change: "archive", dismiss: "none" },
    { field: "labels", change: "permission", dismiss: "before" },
    { field: "labels", change: "archive", dismiss: "after" },
  ] as const)(
    "retains dirty inline $field when live $change removes editability (dismiss=$dismiss)",
    async ({ field, change, dismiss }) => {
      const card = createWorkboardCard({ title: "Original", notes: "Original", labels: [] });
      const client = createWorkboardTestClient({});
      let canWrite = true;
      const { state, container, renderView } = createWorkboardView({
        client,
        onRequestUpdate: () => renderView({ canWrite }),
      });
      state.cards = [card];
      state.detailCardId = card.id;
      state.showArchived = false;
      renderView({ canWrite });
      const editor = await inlineEditor(container, field);
      const { trigger, owner, popover } = editor;
      let input = await editor.open();
      input.value = "Unsaved change";
      input.dispatchEvent(new InputEvent("input", { bubbles: true }));
      const dismissLabels = async () => {
        expectDefined(popover, "labels popover").dispatchEvent(new Event("toggle"));
        await waitForFast(() => expect(owner.querySelector("input")).toBeNull());
      };
      if (dismiss === "before") {
        await dismissLabels();
      }
      if (change === "permission") {
        canWrite = false;
      } else {
        state.cards = [{ ...card, metadata: { ...card.metadata, archivedAt: 1 } }];
      }
      renderView({ canWrite });
      if (dismiss === "after") {
        await waitForFast(() => expect(input.readOnly).toBe(true));
        await dismissLabels();
      }
      if (dismiss !== "none") {
        await waitForFast(() => expect(trigger.disabled).toBe(false));
        trigger.click();
        input = await waitForFast(() =>
          expectDefined(owner.querySelector<HTMLInputElement>("input"), "input"),
        );
      }
      await waitForFast(() => expect(input.readOnly).toBe(true));
      expect(input.disabled).toBe(false);
      expect(input.isConnected).toBe(true);
      expect(input.value).toBe("Unsaved change");
      expect(owner.querySelector("input, textarea")).toBe(input);
      const save = textButton(owner, "Save");
      expect(save.disabled).toBe(true);
      save.click();
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true }),
      );
      expect(client.request).not.toHaveBeenCalled();
      const close = expectDefined(
        container.querySelector<HTMLButtonElement>(".workboard-detail__close"),
        ".workboard-detail__close",
      );
      close.click();
      expect(state.detailCardId).toBe(card.id);
      expect(input.isConnected).toBe(true);
      textButton(container.querySelector(".workboard-discard")!, "Keep editing").click();
      expect(input.value).toBe("Unsaved change");
      expect(input.readOnly).toBe(true);
      expect(input.disabled).toBe(false);
      close.click();
      textButton(container.querySelector(".workboard-discard")!, "Discard").click();
      expect(state.detailCardId).toBeNull();
      expect(input.isConnected).toBe(false);
      expect(client.request).not.toHaveBeenCalled();
    },
  );

  it.each([
    { field: "priority", original: "normal", next: "high" },
    { field: "status", original: "todo", next: "ready" },
  ] as const)(
    "restores native $field selection after rejection so the same option can retry",
    async ({ field, original, next }) => {
      const card = createWorkboardCard({ priority: "normal", status: "todo" });
      let attempts = 0;
      let canonical = card;
      const mutationMethod = field === "status" ? "workboard.cards.move" : "workboard.cards.update";
      const client = createWorkboardTestClient((method) => {
        if (method === "workboard.cards.list") {
          return { cards: [canonical], boards: [] };
        }
        if (method !== mutationMethod) {
          throw new Error(`Unexpected request: ${method}`);
        }
        attempts += 1;
        if (attempts === 1) {
          canonical = { ...card, updatedAt: card.updatedAt + 1 };
          throw new GatewayProtocolRequestError({
            code: "workboard_conflict",
            message: "Review and retry the property.",
            details: { type: "workboard_card_conflict", card: canonical },
          });
        }
        canonical = { ...card, [field]: next, updatedAt: card.updatedAt + 2 };
        return { card: canonical };
      });
      const { state, container, renderView } = createWorkboardView({
        client,
        onRequestUpdate: () => renderView(),
      });
      state.cards = [card];
      state.detailCardId = card.id;
      renderView();
      const propertyOption = (value: string) =>
        expectDefined(
          container.querySelector<HTMLInputElement>(
            `[name="workboard-detail-${field}-${card.id}"][value="${value}"]`,
          ),
          `[name="workboard-detail-${field}-${card.id}"][value="${value}"]`,
        );
      propertyOption(next).click();
      await waitForFast(() => expect(state.error).toContain("Review and retry"));
      await waitForFast(() => {
        expect(state.loading).toBe(false);
        expect(state.mutationReadiness).toBe("ready");
        expect(propertyOption(next).disabled).toBe(false);
      });
      const choice = propertyOption(next);
      const prior = propertyOption(original);
      expect(attempts).toBe(1);
      expect(state.cards[0]?.[field]).toBe(original);
      expect(choice.checked).toBe(false);
      expect(prior.checked).toBe(true);
      choice.click();
      await waitForFast(() => expect(state.cards[0]?.[field]).toBe(next));
      expect(attempts).toBe(2);
      expect(choice.checked).toBe(true);
    },
  );

  it("guards automation navigation while keeping modified clicks native", async () => {
    const card = createWorkboardCard({ title: "Draft automation card" });
    const { state, container, renderView } = createWorkboardView({
      client: createWorkboardTestClient({}),
      onRequestUpdate: () => renderView(),
      detailBoardAutomation: {
        jobId: "job-review",
        status: "loaded",
        job: {
          id: "job-review",
          name: "Review board",
          enabled: true,
          createdAtMs: 1,
          updatedAtMs: 1,
          schedule: { kind: "every", everyMs: 60000 },
          sessionTarget: "isolated",
          wakeMode: "now",
          payload: { kind: "agentTurn", message: "Review the board" },
          state: {},
        },
      },
    });
    state.cards = [card];
    state.detailCardId = card.id;
    renderView();
    const link = expectDefined(
      container.querySelector<HTMLAnchorElement>('.workboard-detail a[href*="/automations?job="]'),
      '.workboard-detail a[href*="/automations?job="]',
    );
    const allowed: boolean[] = [];
    link.addEventListener("click", (event) => {
      allowed.push(!event.defaultPrevented);
      event.preventDefault(); // Record navigation admission without leaving the test page.
    });
    const click = (init: MouseEventInit = {}) =>
      link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, ...init }));
    click();
    expect(allowed).toEqual([true]);
    const trigger = await waitForFast(() =>
      expectDefined(
        container.querySelector<HTMLButtonElement>(".workboard-detail__text-trigger--title"),
        ".workboard-detail__text-trigger--title",
      ),
    );
    trigger.click();
    const input = await waitForFast(() =>
      expectDefined(
        container.querySelector<HTMLInputElement>(".workboard-detail__text-editor--title input"),
        ".workboard-detail__text-editor--title input",
      ),
    );
    input.value = "Unsaved title";
    input.dispatchEvent(new InputEvent("input", { bubbles: true }));
    for (const modifier of [
      { ctrlKey: true },
      { metaKey: true },
      { shiftKey: true },
      { altKey: true },
    ]) {
      click(modifier);
      expect(allowed.at(-1)).toBe(true);
      expect(container.querySelector(".workboard-discard")).toBeNull();
    }
    click();
    expect(allowed.at(-1)).toBe(false);
    expect(input.isConnected).toBe(true);
    textButton(container.querySelector(".workboard-discard")!, "Keep editing").click();
    expect(input.value).toBe("Unsaved title");
    click();
    expect(allowed.at(-1)).toBe(false);
    textButton(container.querySelector(".workboard-discard")!, "Discard").click();
    expect(allowed.at(-1)).toBe(true);
    expect(allowed.filter(Boolean)).toHaveLength(6);
  });

  it("keeps label pills mounted while editing and preserves failed input until Escape", async () => {
    const card = createWorkboardCard({ title: "Label editing", labels: ["review"] });
    const client = createWorkboardTestClient(() => {
      throw new Error("Labels unavailable");
    });
    const { state, container, renderView } = createWorkboardView({
      client,
      onRequestUpdate: () => renderView(),
    });
    state.cards = [card];
    state.detailCardId = card.id;
    renderView();
    await waitForFast(() =>
      expect(container.querySelector(".workboard-detail__labels-popover")).not.toBeNull(),
    );
    const popup = expectDefined(
      container.querySelector<HTMLElement>(".workboard-detail__labels-popover"),
      ".workboard-detail__labels-popover",
    );
    // Native top-layer geometry is covered in the browser; this suite covers editor ownership.
    popup.showPopover = vi.fn();
    const trigger = expectDefined(
      container.querySelector<HTMLButtonElement>(".workboard-detail__text-trigger--labels"),
      ".workboard-detail__text-trigger--labels",
    );
    trigger.click();
    await waitForFast(() => expect(popup.querySelector("input")).not.toBeNull());
    expect(trigger.isConnected).toBe(true);
    expect(trigger.textContent).toContain("review");
    const input = expectDefined(popup.querySelector<HTMLInputElement>("input"), "input");
    input.value = " review, quality, review ";
    input.dispatchEvent(new InputEvent("input", { bubbles: true }));
    buttonByText(popup, "Save")!.click();
    await waitForFast(() => expect(state.error).toContain("Labels unavailable"));
    expect(client.request).toHaveBeenCalledWith("workboard.cards.update", {
      id: card.id,
      expectedUpdatedAt: card.updatedAt,
      patch: { labels: ["review", "quality"] },
    });
    expect(input.value).toBe(" review, quality, review ");
    expect(trigger.isConnected).toBe(true);
    const escape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    input.dispatchEvent(escape);
    await waitForFast(() => expect(popup.querySelector("input")).toBeNull());
    expect(escape.defaultPrevented).toBe(true);
    expect(state.detailCardId).toBe(card.id);
    expect(state.cards[0]?.labels).toEqual(["review"]);
    expect(document.activeElement).toBe(trigger);
  });

  it("opens an edit modal and submits card updates", async () => {
    const { host, state } = createLoadedWorkboardState();
    state.cards = [
      createWorkboardCard({
        title: "Rename me",
        notes: "Old notes",
        labels: ["ui"],
        metadata: { comments: [{ id: "comment-1", body: "Needs owner check", createdAt: 2 }] },
      }),
    ];
    const request = vi.fn(async (method: string) =>
      method === "workboard.cards.comment"
        ? {
            card: {
              ...state.cards[0],
              updatedAt: 2,
              metadata: {
                comments: [
                  ...(state.cards[0]?.metadata?.comments ?? []),
                  { id: "comment-2", body: "Ship after CI", createdAt: 3 },
                ],
              },
            },
          }
        : { card: { ...state.cards[0], title: "Renamed", priority: "high", updatedAt: 3 } },
    );
    const props = createWorkboardRenderProps(host, {
      client: { request } as unknown as GatewayBrowserClient,
      onRequestUpdate: () => undefined,
    });
    const container = document.createElement("div");
    renderInto(container, props);
    container
      .querySelector<HTMLButtonElement>('button[aria-label="Edit card"]')
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    renderInto(container, props);
    expect(container.querySelector("[data-test-dialog]")?.textContent).toContain("Edit card");
    expect(container.querySelector("[data-test-dialog]")?.textContent).toContain(
      "Needs owner check",
    );
    const title = container.querySelector<HTMLInputElement>(".workboard-draft__title");
    expect(title?.value).toBe("Rename me");
    title!.value = "Renamed";
    title!.dispatchEvent(new InputEvent("input", { bubbles: true }));
    const commentInput = container.querySelector<HTMLTextAreaElement>(".workboard-comments__input");
    commentInput!.value = "Ship after CI";
    commentInput!.dispatchEvent(new InputEvent("input", { bubbles: true }));
    renderInto(container, props);
    [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.includes("Create"))
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await Promise.resolve();
    await Promise.resolve();
    expect(request).toHaveBeenCalledWith("workboard.cards.comment", {
      id: "card-1",
      body: "Ship after CI",
    });
    expect(state.cards[0]?.metadata?.comments?.at(-1)?.body).toBe("Ship after CI");
    renderInto(container, props);
    expect(container.querySelector<HTMLInputElement>(".workboard-draft__title")?.value).toBe(
      "Renamed",
    );
    expect(state.editingCardBase?.updatedAt).toBe(2);
    const priority = expectDefined(
      container.querySelector<HTMLInputElement>(
        '.workboard-draft input[name="priority"][value="high"]',
      ),
      '.workboard-draft input[name="priority"][value="high"]',
    );
    priority.click();
    container
      .querySelector<HTMLFormElement>(".workboard-draft")
      ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await Promise.resolve();
    await Promise.resolve();
    expect(request).toHaveBeenCalledWith("workboard.cards.update", {
      id: "card-1",
      expectedUpdatedAt: 2,
      patch: { title: "Renamed", priority: "high" },
    });
    expect(
      request.mock.calls.filter(([method]) => method === "workboard.cards.update"),
    ).toHaveLength(1);
    expect(state.cards[0]).toMatchObject({ title: "Renamed", priority: "high", updatedAt: 3 });
    renderInto(container, props);
    expect(container.querySelector("[data-test-dialog]")).toBeNull();
    container
      .querySelector<HTMLButtonElement>('button[aria-label="Edit card"]')
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    renderInto(container, props);
    expect(container.querySelector<HTMLInputElement>(".workboard-draft__title")?.value).toBe(
      "Renamed",
    );
    expect(container.querySelector<HTMLInputElement>('input[name="priority"]:checked')?.value).toBe(
      "high",
    );
  });

  it.each(["create", "conflict"] as const)(
    "shows %s failure inside the active card editor and preserves retryable input",
    async (operation) => {
      const card = createWorkboardCard({ title: "Original title", notes: "Original notes" });
      const current = { ...card, priority: "high" as const, updatedAt: 2 };
      const message =
        operation === "conflict" ? "Card changed. Review and retry." : `${operation} unavailable`;
      const error =
        operation === "conflict"
          ? new GatewayProtocolRequestError({
              code: "workboard_conflict",
              message,
              details: { type: "workboard_card_conflict", card: current },
            })
          : new Error(message);
      const method = operation === "create" ? "workboard.cards.create" : "workboard.cards.update";
      const saved = { ...current, title: "Unsaved title", notes: "Unsaved notes", updatedAt: 3 };
      const client = createWorkboardTestClient({ [method]: { card: saved } });
      client.request.mockImplementationOnce(async () => {
        throw error;
      });
      const { state, container, renderView } = createWorkboardView({ client });
      state.cards = operation === "create" ? [] : [card];
      renderView();
      expectDefined(
        operation === "create"
          ? buttonByText(container, "New card")
          : buttonByLabel(container, "Edit card"),
        "open card editor",
      ).click();
      renderView();
      const inputs: [string, string][] = [
        [".workboard-draft__title", "Unsaved title"],
        [".workboard-draft__notes", "Unsaved notes"],
      ];
      for (const [selector, value] of inputs) {
        const input = container.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector)!;
        input.value = value;
        input.dispatchEvent(new InputEvent("input", { bubbles: true }));
      }
      const submit = () => {
        container
          .querySelector<HTMLFormElement>(".workboard-draft")!
          .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      };
      submit();
      await waitForFast(() => expect(state.error).toContain(message));
      renderView();
      expect(client.request).toHaveBeenCalledWith(method, expect.anything());
      const errorToast = toast(container.querySelector("[data-test-dialog]")!);
      await waitForFast(() => expect(errorToast?.querySelector('[role="alert"]')).not.toBeNull());
      const alert = expectDefined(
        errorToast?.querySelector<HTMLElement>('[role="alert"]'),
        '[role="alert"]',
      );
      expect(alert.textContent).toContain(message);
      expect(alert.closest('[inert], [aria-hidden="true"]')).toBeNull();
      expect(errorToast.closest('[inert], [aria-hidden="true"]')).toBeNull();
      expect(container.querySelector<HTMLInputElement>(".workboard-draft__title")?.value).toBe(
        "Unsaved title",
      );
      expect(container.querySelector<HTMLTextAreaElement>(".workboard-draft__notes")?.value).toBe(
        "Unsaved notes",
      );
      if (operation === "conflict") {
        expect(alert.textContent).toContain("Your unsaved edits remain in the form.");
        expect(
          container.querySelector<HTMLInputElement>('input[name="priority"]:checked')?.value,
        ).toBe("high");
      }
      submit();
      await waitForFast(() => {
        expect(state.draftSaving).toBe(false);
        expect(state.busyCardIds.size).toBe(0);
      });
      renderView();
      expect(client.request).toHaveBeenCalledTimes(2);
      expect(state.error).toBeNull();
      expect(state.draftOpen).toBe(false);
    },
  );

  it.each(["failure", "drawer close"] as const)(
    "preserves a detail note through %s until it saves",
    async (interruption) => {
      const card = createWorkboardCard(
        interruption === "failure"
          ? { title: "Review this card" }
          : { title: "Investigate proof gap", status: "review" },
      );
      const comment = {
        id: interruption === "failure" ? "note" : "comment-1",
        body: interruption === "failure" ? "Keep this note until it saves." : "Need Linux proof.",
        createdAt: 2,
      };
      const saved = { card: { ...card, metadata: { comments: [comment] } } };
      const pending = createDeferred<{ card: typeof card }>();
      const client =
        interruption === "failure"
          ? createWorkboardTestClient({ "workboard.cards.comment": saved })
          : createWorkboardTestClient(() => pending.promise);
      if (interruption === "failure") {
        client.request.mockImplementationOnce(async () => {
          throw new Error("Note unavailable");
        });
      }
      const { state, container, renderView } = createWorkboardView({ client });
      state.cards = [card];
      renderView();
      requireButton(container, "View details").click();
      if (interruption === "drawer close") {
        renderView();
      }
      state.detailTab = "activity";
      renderView();
      const note = expectDefined(
        container.querySelector<HTMLTextAreaElement>(".workboard-detail__note"),
        ".workboard-detail__note",
      );
      note.value = interruption === "failure" ? comment.body : ` ${comment.body} `;
      note.dispatchEvent(new InputEvent("input", { bubbles: true }));
      renderView();
      textButton(container, "Add note").click();
      if (interruption === "failure") {
        await waitForFast(() => expect(state.error).toBe("Note unavailable"));
        renderView();
        const errorToast = toast(container.querySelector("[data-test-dialog]")!);
        await waitForFast(() => expect(errorToast?.querySelector('[role="alert"]')).not.toBeNull());
        const alert = expectDefined(
          errorToast?.querySelector<HTMLElement>('[role="alert"]'),
          '[role="alert"]',
        );
        expect(alert.textContent).toContain("Note unavailable");
        expect(alert.closest('[inert], [aria-hidden="true"]')).toBeNull();
        expect(errorToast.closest('[inert], [aria-hidden="true"]')).toBeNull();
        expect(note.value).toBe(comment.body);
        textButton(container, "Add note").click();
      } else {
        renderView();
        expect(note.disabled).toBe(true);
        requireButton(container.querySelector(".workboard-detail")!, "Close").click();
        renderView();
        requireButton(container, "View details").click();
        renderView();
        expect(state.detailCommentBody).toBe(` ${comment.body} `);
        pending.resolve(saved);
      }
      await waitForFast(() => expect(state.busyCardIds.size).toBe(0));
      renderView();
      expect(container.querySelector(".workboard-detail__comments")?.textContent).toContain(
        comment.body,
      );
      if (interruption === "failure") {
        expect(client.request).toHaveBeenCalledTimes(2);
        expect(state.error).toBeNull();
        expect(note.value).toBe("");
      } else {
        expect(client.request).toHaveBeenCalledWith("workboard.cards.comment", {
          id: card.id,
          body: comment.body,
        });
        expect(state.detailCommentBody).toBe("");
        expect(state.detailCommentDrafts.has(card.id)).toBe(false);
      }
    },
  );

  it("keeps another card's editor draft when an earlier note finishes", async () => {
    const first = createWorkboardCard({ title: "First card" });
    const second = createWorkboardCard({ id: "card-2", title: "Second card" });
    const body = "Review this card.";
    const pending = createDeferred<{
      card: typeof first;
    }>();
    const client = createWorkboardTestClient(() => pending.promise);
    const { state, container, renderView } = createWorkboardView({ client });
    state.cards = [first, second];
    renderView();
    const editCard = (title: string) => {
      const card = expectDefined(
        [...container.querySelectorAll("article.workboard-card")].find(
          (candidate) => candidate.querySelector("h3")?.textContent === title,
        ),
        "card to edit",
      );
      requireButton(card, "Edit card").click();
      renderView();
    };
    const typeNote = () => {
      const input = expectDefined(
        container.querySelector<HTMLTextAreaElement>(".workboard-comments__input"),
        ".workboard-comments__input",
      );
      input.value = body;
      input.dispatchEvent(new InputEvent("input", { bubbles: true }));
      return input;
    };
    editCard(first.title);
    typeNote();
    const submit = await waitForFast(() => {
      const button = expectDefined(
        container.querySelector<HTMLButtonElement>(".workboard-comments__submit"),
        ".workboard-comments__submit",
      );
      expect(button.disabled).toBe(false);
      return button;
    });
    submit.click();
    renderView();
    requireButton(container, "Cancel").click();
    renderView();
    editCard(second.title);
    const nextNote = typeNote();
    renderView();
    pending.resolve({
      card: { ...first, metadata: { comments: [{ id: "note-1", body, createdAt: 2 }] } },
    });
    await waitForFast(() => expect(state.busyCardIds.size).toBe(0));
    renderView();
    expect(state.editingCardId).toBe(second.id);
    expect(state.draftCommentBody).toBe(body);
    expect(nextNote.value).toBe(body);
    expect(
      container.querySelector<HTMLButtonElement>(".workboard-comments__submit")?.disabled,
    ).toBe(false);
    expect(state.cards.find((card) => card.id === first.id)?.metadata?.comments?.[0]?.body).toBe(
      body,
    );
  });

  it.each(["available", "missing"] as const)("offers %s linked session choices", (availability) => {
    const { host, state } = createLoadedWorkboardState();
    state.draftOpen = true;
    const missingKey = "agent:main:archived-session";
    if (availability === "missing") {
      state.draftSessionKey = missingKey;
    }
    const container = document.createElement("div");
    const props = createWorkboardRenderProps(host, {
      sessions:
        availability === "available"
          ? [
              {
                key: "agent:main:dashboard:1",
                kind: "direct",
                displayName: "Existing session",
                updatedAt: 2,
              },
              createGatewaySession({ key: "global", kind: "global", agentId: "main" }),
              createGatewaySession({ key: "unknown", kind: "unknown", agentId: "main" }),
              createGatewaySession({ key: "agent:writer:unknown", agentId: "writer" }),
            ]
          : [],
    });
    renderInto(container, props);
    const picker = sessionPicker(container);
    if (availability === "available") {
      expect(picker.options.map((option) => option.label)).toContain("No linked session");
      expect(picker.options.map((option) => option.label)).toContain("Existing session");
      expect(picker.options.map((option) => option.value)).toEqual([
        "",
        "agent:main:dashboard:1",
        "agent:writer:unknown",
      ]);
    } else {
      expect(picker.value).toBe(missingKey);
      expect(picker.options).toContainEqual({ value: missingKey, label: missingKey });
    }
  });
});
