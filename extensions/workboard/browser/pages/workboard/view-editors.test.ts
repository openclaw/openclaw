import "../../test/dom.setup.ts";
import { GatewayProtocolRequestError } from "@openclaw/gateway-client/browser";
import { expectDefined } from "@openclaw/normalization-core";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { flush } from "solid-js";
import { expect, it, onTestFinished, vi } from "vitest";
import { resetWorkboardConnectionState } from "../../lib/workboard/index.ts";
import {
  createGatewaySession,
  createWorkboardCard,
  createWorkboardTestClient,
} from "../../lib/workboard/test/index-helpers.ts";
import { waitForFast } from "../../test/wait-for.ts";
import {
  fill,
  submitForm,
  query,
  createWorkboardView,
  buttonByLabel,
  buttonByText,
  requireButton,
  textButton,
  inlineEditor,
  sessionPicker,
  toast,
} from "./view.test-support.ts";

function detailView(
  card: ReturnType<typeof createWorkboardCard>,
  overrides: Parameters<typeof createWorkboardView>[0] = {},
) {
  return createWorkboardView(overrides, {}, { cards: [card], detailCardId: card.id });
}

async function visibleError(container: Element, message: string) {
  const errorToast = toast(query(container, "[data-test-dialog]"));
  const alert = await waitForFast(() => query(errorToast, '[role="alert"]'));
  expect(alert.textContent).toContain(message);
  expect(alert.closest('[inert], [aria-hidden="true"]')).toBeNull();
  expect(errorToast.closest('[inert], [aria-hidden="true"]')).toBeNull();
  return alert;
}

it("keeps a stale edit draft disabled until it is cancelled", async () => {
  const { find, host, state, renderView } = createWorkboardView();
  state.cards = [createWorkboardCard({ title: "Canonical title" })];
  state.draftOpen = true;
  state.editingCardId = "card-1";
  state.draftTitle = "Unsaved edit";
  resetWorkboardConnectionState(host);
  renderView();
  state.mutationReadiness = "stale_edit_draft";
  renderView();
  expect(find<HTMLButtonElement>(".workboard-modal__actions .primary")?.disabled).toBe(true);
  expect(find<HTMLInputElement>(".workboard-draft__title")?.value).toBe("Unsaved edit");
  const cancelButton = find<HTMLButtonElement>('button[aria-label="Cancel"]');
  expect(cancelButton?.disabled).toBe(false);
  cancelButton?.click();
  expect(state.draftOpen).toBe(false);
});

it("passes dialog labels and cancellation back to the plugin draft owner", async () => {
  const { get, find, state, container, renderView } = createWorkboardView({
    onRequestUpdate: () => renderView(),
  });
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
  renderView();
  expect(get(".workboard > openclaw-workboard-toast").hidden).toBe(true);
  const dialog = find("[data-test-dialog]")!;
  expect(dialog.getAttribute("aria-label")).toBe("New card");
  expect(dialog.getAttribute("aria-description")).toContain("Queue work");
  state.draftSaving = true;
  renderView();
  const blocked = new Event("cancel", { cancelable: true });
  dialog.dispatchEvent(blocked);
  expect(blocked.defaultPrevented).toBe(true);
  expect(state.draftOpen).toBe(true);
  state.draftSaving = false;
  renderView();
  dialog.dispatchEvent(new Event("cancel", { cancelable: true }));
  expect(state).toMatchObject({ draftDiscardOpen: true, draftOpen: true });
  textButton(find(".workboard-discard")!, "Discard").click();
  expect(state.draftOpen).toBe(false);
  expect(find(".workboard-draft")).toBeNull();
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
  const { get, find, state, container, renderView } = createWorkboardView({
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
    const input = get<HTMLInputElement | HTMLTextAreaElement>(selector);
    expect(input.value).toBe(value);
    fill(input, `Edited ${value}`);
  }
  template.click();
  renderView();
  for (const [selector, value] of fields) {
    expect(find<HTMLInputElement | HTMLTextAreaElement>(selector)?.value).toBe(value);
  }
  const form = find<HTMLFormElement>(".workboard-draft")!;
  const submit = form.querySelector<HTMLButtonElement>(".workboard-draft__submit")!;
  expect(submit.form).toBe(form);
  expect(form.lastElementChild?.contains(submit)).toBe(true);
  submitForm(form);
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
    const card = createWorkboardCard({ title: "Original title", notes: "Original notes" });
    const value = "Edited text";
    const patch = { [field]: value };
    const client = createWorkboardTestClient(() => ({
      card: { ...card, ...patch, updatedAt: card.updatedAt + 1 },
    }));
    const { state, container, renderView } = detailView(card, { client });
    renderView();
    const editor = await inlineEditor(container, field);
    const { owner } = editor;
    const input = await editor.open();
    fill(input, value);
    const save = textButton(owner, "Save");
    for (const unavailable of [
      { connected: false, client },
      { connected: true, client: null },
    ]) {
      renderView(unavailable);
      await waitForFast(() => expect([input.disabled, save.disabled]).toEqual([true, true]));
      expect(input).toMatchObject({ isConnected: true, value });
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
  const { container, renderView } = detailView(card, {
    client: createWorkboardTestClient({}),
  });
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
  const { state, container, renderView } = detailView(card, {
    client: createWorkboardTestClient({}),
  });
  renderView();
  const editor = await inlineEditor(container, "labels");
  const { trigger } = editor;
  const popup = expectDefined(editor.popover, "labels popover");
  const matches = vi.spyOn(popup, "matches").mockReturnValue(false);
  onTestFinished(() => matches.mockRestore());
  const input = await editor.open();
  fill(input, "original, pending");
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
  { field: "notes", change: "archive", dismiss: "none" },
  { field: "labels", change: "permission", dismiss: "before" },
  { field: "labels", change: "archive", dismiss: "after" },
] as const)(
  "retains dirty inline $field when live $change removes editability (dismiss=$dismiss)",
  async ({ field, change, dismiss }) => {
    const card = createWorkboardCard({ title: "Original", notes: "Original", labels: [] });
    const client = createWorkboardTestClient({});
    let canWrite = true;
    const { get, find, state, container, renderView } = detailView(card, {
      client,
      onRequestUpdate: () => renderView({ canWrite }),
    });
    state.showArchived = false;
    renderView({ canWrite });
    const editor = await inlineEditor(container, field);
    const { trigger, owner, popover } = editor;
    let input = await editor.open();
    fill(input, "Unsaved change");
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
      input = await waitForFast(() => query<HTMLInputElement>(owner, "input"));
    }
    await waitForFast(() => expect(input.readOnly).toBe(true));
    expect(input).toMatchObject({ disabled: false, isConnected: true, value: "Unsaved change" });
    expect(owner.querySelector("input, textarea")).toBe(input);
    const save = textButton(owner, "Save");
    expect(save.disabled).toBe(true);
    save.click();
    input.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true }),
    );
    expect(client.request).not.toHaveBeenCalled();
    const close = get<HTMLButtonElement>(".workboard-detail__close");
    close.click();
    expect(state.detailCardId).toBe(card.id);
    expect(input.isConnected).toBe(true);
    textButton(find(".workboard-discard")!, "Keep editing").click();
    expect(input).toMatchObject({ value: "Unsaved change", readOnly: true, disabled: false });
    close.click();
    textButton(find(".workboard-discard")!, "Discard").click();
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
    const { get, state, renderView } = detailView(card, {
      client,
      onRequestUpdate: () => renderView(),
    });
    renderView();
    const propertyOption = (value: string) =>
      get<HTMLInputElement>(`[name="workboard-detail-${field}-${card.id}"][value="${value}"]`);
    propertyOption(next).click();
    await waitForFast(() => expect(state.error).toContain("Review and retry"));
    await waitForFast(() => {
      expect(state).toMatchObject({ loading: false, mutationReadiness: "ready" });
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
  const { get, find, renderView } = detailView(card, {
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
  renderView();
  const link = get<HTMLAnchorElement>('.workboard-detail a[href*="/automations?job="]');
  const allowed: boolean[] = [];
  link.addEventListener("click", (event) => {
    allowed.push(!event.defaultPrevented);
    event.preventDefault(); // Record navigation admission without leaving the test page.
  });
  const click = (init: MouseEventInit = {}) =>
    link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, ...init }));
  click();
  expect(allowed).toEqual([true]);
  const input = await (await inlineEditor(link.closest(".workboard-detail")!, "title")).open();
  fill(input, "Unsaved title");
  for (const modifier of ["ctrlKey", "metaKey", "shiftKey", "altKey"] as const) {
    click({ [modifier]: true });
    expect(allowed.at(-1)).toBe(true);
    expect(find(".workboard-discard")).toBeNull();
  }
  click();
  expect(allowed.at(-1)).toBe(false);
  expect(input.isConnected).toBe(true);
  textButton(find(".workboard-discard")!, "Keep editing").click();
  expect(input.value).toBe("Unsaved title");
  click();
  expect(allowed.at(-1)).toBe(false);
  textButton(find(".workboard-discard")!, "Discard").click();
  expect(allowed.at(-1)).toBe(true);
  expect(allowed.filter(Boolean)).toHaveLength(6);
});

it("keeps label pills mounted while editing and preserves failed input until Escape", async () => {
  const card = createWorkboardCard({ title: "Label editing", labels: ["review"] });
  const client = createWorkboardTestClient(() => {
    throw new Error("Labels unavailable");
  });
  const { state, container, renderView } = detailView(card, {
    client,
    onRequestUpdate: () => renderView(),
  });
  renderView();
  const { trigger, popover, open } = await inlineEditor(container, "labels");
  const popup = expectDefined(popover, "labels popover");
  const input = await open();
  expect(trigger.isConnected).toBe(true);
  expect(trigger.textContent).toContain("review");
  fill(input, " review, quality, review ");
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
  const comments = [{ id: "comment-1", body: "Needs owner check", createdAt: 2 }];
  const card = createWorkboardCard({ title: "Rename me", metadata: { comments } });
  const commented = {
    ...card,
    updatedAt: 2,
    metadata: { comments: [...comments, { id: "comment-2", body: "Ship after CI", createdAt: 3 }] },
  };
  const client = createWorkboardTestClient((method) =>
    method === "workboard.cards.comment"
      ? { card: commented }
      : { card: { ...commented, title: "Renamed", priority: "high", updatedAt: 3 } },
  );
  const { request } = client;
  const { get, find, state, container, renderView } = createWorkboardView({
    client,
    onRequestUpdate: () => undefined,
  });
  state.cards = [card];
  const edit = () => {
    requireButton(container, "Edit card").click();
    renderView();
  };
  renderView();
  edit();
  expect(find("[data-test-dialog]")?.textContent).toContain("Edit card");
  expect(find("[data-test-dialog]")?.textContent).toContain("Needs owner check");
  const title = get<HTMLInputElement>(".workboard-draft__title");
  expect(title.value).toBe("Rename me");
  fill(title, "Renamed");
  fill(get<HTMLTextAreaElement>(".workboard-comments__input"), "Ship after CI");
  renderView();
  textButton(container, "Create").click();
  await Promise.resolve();
  await Promise.resolve();
  expect(request).toHaveBeenCalledWith("workboard.cards.comment", {
    id: "card-1",
    body: "Ship after CI",
  });
  expect(state.cards[0]?.metadata?.comments?.at(-1)?.body).toBe("Ship after CI");
  renderView();
  expect(find<HTMLInputElement>(".workboard-draft__title")?.value).toBe("Renamed");
  expect(state.editingCardBase?.updatedAt).toBe(2);
  get<HTMLInputElement>('.workboard-draft input[name="priority"][value="high"]').click();
  submitForm(get<HTMLFormElement>(".workboard-draft"));
  await Promise.resolve();
  await Promise.resolve();
  expect(request).toHaveBeenCalledWith("workboard.cards.update", {
    id: "card-1",
    expectedUpdatedAt: 2,
    patch: { title: "Renamed", priority: "high" },
  });
  expect(request.mock.calls.filter(([method]) => method === "workboard.cards.update")).toHaveLength(
    1,
  );
  expect(state.cards[0]).toMatchObject({ title: "Renamed", priority: "high", updatedAt: 3 });
  renderView();
  expect(find("[data-test-dialog]")).toBeNull();
  edit();
  expect(find<HTMLInputElement>(".workboard-draft__title")?.value).toBe("Renamed");
  expect(find<HTMLInputElement>('input[name="priority"]:checked')?.value).toBe("high");
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
    const { find, state, container, renderView } = createWorkboardView({ client });
    state.cards = operation === "create" ? [] : [card];
    renderView();
    expectDefined(
      operation === "create"
        ? buttonByText(container, "New card")
        : buttonByLabel(container, "Edit card"),
      "open card editor",
    ).click();
    renderView();
    for (const field of ["title", "notes"]) {
      fill(
        find<HTMLInputElement | HTMLTextAreaElement>(`.workboard-draft__${field}`)!,
        `Unsaved ${field}`,
      );
    }
    const submit = () => submitForm(find<HTMLFormElement>(".workboard-draft")!);
    submit();
    await waitForFast(() => expect(state.error).toContain(message));
    renderView();
    expect(client.request).toHaveBeenCalledWith(method, expect.anything());
    const alert = await visibleError(container, message);
    expect(find<HTMLInputElement>(".workboard-draft__title")?.value).toBe("Unsaved title");
    expect(find<HTMLTextAreaElement>(".workboard-draft__notes")?.value).toBe("Unsaved notes");
    if (operation === "conflict") {
      expect(alert.textContent).toContain("Your unsaved edits remain in the form.");
      expect(find<HTMLInputElement>('input[name="priority"]:checked')?.value).toBe("high");
    }
    submit();
    await waitForFast(() => {
      expect(state.draftSaving).toBe(false);
      expect(state.busyCardIds.size).toBe(0);
    });
    renderView();
    expect(client.request).toHaveBeenCalledTimes(2);
    expect(state).toMatchObject({ error: null, draftOpen: false });
  },
);

it.each(["failure", "drawer close"] as const)(
  "preserves a detail note through %s until it saves",
  async (interruption) => {
    const card = createWorkboardCard({ status: interruption === "failure" ? "todo" : "review" });
    const comment = { id: "note", body: "Keep this note until it saves.", createdAt: 2 };
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
    const { get, find, state, container, renderView } = createWorkboardView({ client });
    state.cards = [card];
    renderView();
    requireButton(container, "View details").click();
    if (interruption === "drawer close") {
      renderView();
    }
    state.detailTab = "activity";
    renderView();
    const note = get<HTMLTextAreaElement>(".workboard-detail__note");
    fill(note, interruption === "failure" ? comment.body : ` ${comment.body} `);
    renderView();
    textButton(container, "Add note").click();
    if (interruption === "failure") {
      await waitForFast(() => expect(state.error).toBe("Note unavailable"));
      renderView();
      await visibleError(container, "Note unavailable");
      expect(note.value).toBe(comment.body);
      textButton(container, "Add note").click();
    } else {
      renderView();
      expect(note.disabled).toBe(true);
      requireButton(find(".workboard-detail")!, "Close").click();
      renderView();
      requireButton(container, "View details").click();
      renderView();
      expect(state.detailCommentBody).toBe(` ${comment.body} `);
      pending.resolve(saved);
    }
    await waitForFast(() => expect(state.busyCardIds.size).toBe(0));
    renderView();
    expect(find(".workboard-detail__comments")?.textContent).toContain(comment.body);
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
  const pending = createDeferred<{ card: typeof first }>();
  const client = createWorkboardTestClient(() => pending.promise);
  const { get, find, all, state, container, renderView } = createWorkboardView({ client });
  state.cards = [first, second];
  renderView();
  const editCard = (title: string) => {
    const card = expectDefined(
      [...all("article.workboard-card")].find(
        (candidate) => candidate.querySelector("h3")?.textContent === title,
      ),
      "card to edit",
    );
    requireButton(card, "Edit card").click();
    renderView();
  };
  const typeNote = () => {
    const input = get<HTMLTextAreaElement>(".workboard-comments__input");
    fill(input, body);
    return input;
  };
  editCard(first.title);
  typeNote();
  const submit = await waitForFast(() => {
    const button = get<HTMLButtonElement>(".workboard-comments__submit");
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
  expect(state).toMatchObject({ editingCardId: second.id, draftCommentBody: body });
  expect(nextNote.value).toBe(body);
  expect(find<HTMLButtonElement>(".workboard-comments__submit")?.disabled).toBe(false);
  expect(state.cards.find((card) => card.id === first.id)?.metadata?.comments?.[0]?.body).toBe(
    body,
  );
});

it.each(["available", "missing"] as const)("offers %s linked session choices", (availability) => {
  const missingKey = "agent:main:archived-session";
  const { state, container, renderView } = createWorkboardView({
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
  state.draftOpen = true;
  if (availability === "missing") {
    state.draftSessionKey = missingKey;
  }
  renderView();
  const picker = sessionPicker(container);
  if (availability === "available") {
    expect(picker.options.map((option) => option.label)).toEqual(
      expect.arrayContaining(["No linked session", "Existing session"]),
    );
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
