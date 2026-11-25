/* @vitest-environment jsdom */

import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { ask } from "./ask-dialog.js";
import type { Page } from "./page-context.js";

const record = { id: "rec-1", title: "Birdclaw", kind: "page", revision: 4, hash: "a".repeat(64) };

beforeAll(() => {
  // jsdom implements <dialog> without the modal API.
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
});

afterEach(() => {
  document.body.replaceChildren();
});

// Mounts the dialog against a fake host whose sessions.create result is supplied by the test.
function mount(created: unknown, options: { correct?: boolean } = {}) {
  const root = document.createElement("div");
  document.body.append(root);
  const request = vi.fn(async () => created);
  const open = vi.fn();
  const host = { request, sessions: { open, refresh: vi.fn(async () => {}) } };
  const ui = {
    s: { agentId: "main", context: { host } },
    root,
    errorText: (error: unknown) => (error instanceof Error ? error.message : String(error)),
    agentName: () => "main",
    askLabel: () => "Ask main",
  } as unknown as Page;
  ask(ui, record, options.correct);
  const prompt = root.querySelector("textarea")!;
  const buttons = [...root.querySelectorAll("button")];
  const askButton = buttons.find((b) => b.textContent === "Ask")!;
  return { root, prompt, buttons, askButton, request, open };
}

it("shows only the editable request and Cancel/Ask actions", () => {
  const { prompt, buttons } = mount({ ok: true, key: "k" });
  expect(prompt.readOnly).toBe(false);
  expect(prompt.value).toBe('What do you know about "Birdclaw", and where did it come from?');
  expect(prompt.value).not.toMatch(/ID:|Revision:|Hash:/);
  expect(buttons.map((b) => b.textContent)).toEqual(["Cancel", "Ask"]);
});

it("starts a new chat with the edited request and the record reference, then opens it", async () => {
  const { root, prompt, askButton, request, open } = mount({ ok: true, key: "agent:main:new" });
  prompt.value = "Where did Birdclaw come from?";
  prompt.dispatchEvent(new Event("input"));
  askButton.click();
  await vi.waitFor(() => expect(open).toHaveBeenCalled());
  expect(request).toHaveBeenCalledWith("sessions.create", {
    agentId: "main",
    message: `Where did Birdclaw come from?\n\nRecord: Birdclaw\nID: rec-1\nRevision: 4\nHash: ${"a".repeat(64)}`,
  });
  expect(open).toHaveBeenCalledWith({ sessionKey: "agent:main:new", agentId: "main" });
  expect(root.querySelector("dialog")).toBeNull();
});

it("keeps the request when the first turn is not sent", async () => {
  const { root, prompt, askButton, open } = mount(
    { ok: true, key: "agent:main:new", runError: { message: "model unavailable" } },
    { correct: true },
  );
  prompt.value += "The date moved.";
  askButton.click();
  await vi.waitFor(() =>
    expect(root.querySelector("[role=status]")!.textContent).toMatch(/model unavailable/),
  );
  expect(open).not.toHaveBeenCalled();
  expect(prompt.value).toMatch(/The date moved\.$/);
});

it("cannot send a blank request", () => {
  const { prompt, askButton } = mount({ ok: true, key: "k" });
  prompt.value = "  ";
  prompt.dispatchEvent(new Event("input"));
  expect(askButton.disabled).toBe(true);
});
