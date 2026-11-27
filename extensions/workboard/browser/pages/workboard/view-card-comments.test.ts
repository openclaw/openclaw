import "../../test/dom.setup.ts";
import { expectDefined } from "@openclaw/normalization-core";
import { expect, it } from "vitest";
import {
  createWorkboardCard,
  createWorkboardTestClient,
} from "../../lib/workboard/test/index-helpers.ts";
import { waitForFast } from "../../test/wait-for.ts";
import { createWorkboardView, openCardMenu, requireButton } from "./view.test-support.ts";

it.each([
  { action: "Edit card", field: ".workboard-comments__input", submit: "Create", word: "pear" },
  { action: "View details", field: ".workboard-detail__note", submit: "Add note", word: "peas" },
])("saves the entire padded comment from $action", async ({ action, field, submit, word }) => {
  const card = createWorkboardCard({ title: "Garden notebook" });
  const body = `${"🌱 ".padEnd(1996, "x")}${word}`;
  const pasted = ` ${body} `;
  const comment = { id: "garden-note", body, createdAt: 2 };
  const client = createWorkboardTestClient({
    "workboard.cards.comment": { card: { ...card, metadata: { comments: [comment] } } },
  });
  const { state, container, renderView } = createWorkboardView({ client });
  state.cards = [card];
  renderView();
  const tile = expectDefined(container.querySelector(".workboard-card"), "card");
  requireButton(openCardMenu(tile), action).click();
  renderView();
  if (action === "View details") {
    requireButton(container, "Activity").click();
    renderView();
  }
  const input = expectDefined(container.querySelector<HTMLTextAreaElement>(field), "comment");
  // Setting the value in jsdom skips the native length constraint applied during paste.
  expect(pasted.length).toBeLessThanOrEqual(input.maxLength < 0 ? Infinity : input.maxLength);
  input.value = pasted;
  input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertFromPaste" }));
  renderView();
  requireButton(container, submit).click();

  await waitForFast(() => expect(state.busyCardIds.size).toBe(0));
  expect(client.request).toHaveBeenCalledExactlyOnceWith("workboard.cards.comment", {
    id: card.id,
    body,
  });
  renderView();
  expect(input.value).toBe("");
});
