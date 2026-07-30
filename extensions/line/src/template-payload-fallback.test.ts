// Line tests cover template payload textual fallback and blank-value handling.
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import { buildTemplateMessageFromPayload } from "./template-messages.js";

describe("template payload textual fallback", () => {
  it("delivers carousel column content as text when no column is deliverable", () => {
    const message = buildTemplateMessageFromPayload({
      type: "carousel",
      columns: [
        { title: "First", text: "A", actions: [] },
        { text: "B", actions: [] },
      ],
    });

    expect(message).toEqual({ type: "text", text: "First: A\nB" });
  });

  it("prefers the carousel altText for the fallback when provided", () => {
    const message = buildTemplateMessageFromPayload({
      type: "carousel",
      columns: [{ text: "A", actions: [] }],
      altText: "Two options",
    });

    expect(message).toEqual({ type: "text", text: "Two options" });
  });

  it("drops blank-label buttons actions and keeps the labeled rest", () => {
    const message = buildTemplateMessageFromPayload({
      type: "buttons",
      text: "Pick",
      actions: [
        { type: "message", label: "" },
        { type: "message", label: "One" },
      ],
    });

    const template = expectDefined(message, "buttons template message");
    if (template.type !== "template" || template.template.type !== "buttons") {
      throw new Error("expected a buttons template");
    }
    expect(template.template.actions).toEqual([{ type: "message", label: "One", text: "One" }]);
  });

  it("delivers buttons title and text as text when every action label is blank", () => {
    const message = buildTemplateMessageFromPayload({
      type: "buttons",
      title: "Menu",
      text: "Pick",
      actions: [{ type: "message", label: "" }],
    });

    expect(message).toEqual({ type: "text", text: "Menu: Pick" });
  });

  it("delivers the confirm question as text when a label is blank", () => {
    const message = buildTemplateMessageFromPayload({
      type: "confirm",
      text: "Continue?",
      confirmLabel: "",
      confirmData: "yes",
      cancelLabel: "No",
      cancelData: "no",
    });

    expect(message).toEqual({ type: "text", text: "Continue?" });
  });

  it("sends the label when a template action's data is blank", () => {
    const message = buildTemplateMessageFromPayload({
      type: "buttons",
      text: "Pick",
      actions: [{ type: "postback", label: "Go", data: "" }],
    });

    const template = expectDefined(message, "buttons template message");
    if (template.type !== "template" || template.template.type !== "buttons") {
      throw new Error("expected a buttons template");
    }
    expect(template.template.actions).toEqual([{ type: "message", label: "Go", text: "Go" }]);
  });

  it("sends the labels when confirm data values are blank", () => {
    const message = buildTemplateMessageFromPayload({
      type: "confirm",
      text: "Continue?",
      confirmLabel: "Yes",
      confirmData: "",
      cancelLabel: "No",
      cancelData: "  ",
    });

    const template = expectDefined(message, "confirm template message");
    if (template.type !== "template" || template.template.type !== "confirm") {
      throw new Error("expected a confirm template");
    }
    expect(template.template.actions).toEqual([
      { type: "message", label: "Yes", text: "Yes" },
      { type: "message", label: "No", text: "No" },
    ]);
  });

  it("keeps an authored title that happens to match the text", () => {
    const message = buildTemplateMessageFromPayload({
      type: "buttons",
      title: "Menu",
      text: "Menu",
      actions: [{ type: "message", label: "One", data: "one" }],
    });

    const template = expectDefined(message, "buttons template message");
    if (template.type !== "template" || template.template.type !== "buttons") {
      throw new Error("expected a buttons template");
    }
    expect(template.template.title).toBe("Menu");
    expect(template.template.text).toBe("Menu");
  });

  it("folds a blank-text carousel column's title so its actions survive", () => {
    const message = buildTemplateMessageFromPayload({
      type: "carousel",
      columns: [
        { title: "First", text: " ", actions: [{ type: "message", label: "A", data: "a" }] },
        { title: "Second", text: "Body", actions: [{ type: "message", label: "B", data: "b" }] },
      ],
    });

    const template = expectDefined(message, "carousel template message");
    if (template.type !== "template" || template.template.type !== "carousel") {
      throw new Error("expected a carousel template");
    }
    // The folded column loses its title slot, which folds the sibling's title
    // into its text for cross-column consistency.
    expect(template.template.columns).toEqual([
      expect.objectContaining({ text: "First" }),
      expect.objectContaining({ text: "Second: Body" }),
    ]);
    expect(template.template.columns[0]?.title).toBeUndefined();
    expect(template.template.columns[1]?.title).toBeUndefined();
  });

  it("uses the title alone in the fallback for a blank-text column", () => {
    const message = buildTemplateMessageFromPayload({
      type: "carousel",
      columns: [
        { title: "First", text: " ", actions: [] },
        { text: "B", actions: [] },
      ],
    });

    expect(message).toEqual({ type: "text", text: "First\nB" });
  });

  it("folds the title into blank buttons text so the actions stay deliverable", () => {
    const message = buildTemplateMessageFromPayload({
      type: "buttons",
      title: "Menu",
      text: "  ",
      actions: [{ type: "message", label: "One", data: "one" }],
    });

    const template = expectDefined(message, "buttons template message");
    if (template.type !== "template" || template.template.type !== "buttons") {
      throw new Error("expected a buttons template");
    }
    expect(template.template.title).toBeUndefined();
    expect(template.template.text).toBe("Menu");
    expect(template.template.actions).toEqual([{ type: "message", label: "One", text: "one" }]);
  });

  it("delivers the confirm altText as text when the question is blank", () => {
    const message = buildTemplateMessageFromPayload({
      type: "confirm",
      text: " ",
      confirmLabel: "Yes",
      confirmData: "yes",
      cancelLabel: "No",
      cancelData: "no",
      altText: "Continue?",
    });

    expect(message).toEqual({ type: "text", text: "Continue?" });
  });

  it("drops a carousel column whose text is blank", () => {
    const message = buildTemplateMessageFromPayload({
      type: "carousel",
      columns: [
        { text: " ", actions: [{ type: "message", label: "A", data: "a" }] },
        { text: "Keep", actions: [{ type: "message", label: "B", data: "b" }] },
      ],
    });

    const template = expectDefined(message, "carousel template message");
    if (template.type !== "template" || template.template.type !== "carousel") {
      throw new Error("expected a carousel template");
    }
    expect(template.template.columns).toHaveLength(1);
    expect(template.template.columns[0]?.text).toBe("Keep");
  });

  it("fails loudly when a template payload has nothing deliverable", () => {
    expect(() =>
      buildTemplateMessageFromPayload({
        type: "confirm",
        text: " ",
        confirmLabel: "",
        confirmData: "",
        cancelLabel: "",
        cancelData: "",
      }),
    ).toThrow(/no deliverable/);
  });
});
