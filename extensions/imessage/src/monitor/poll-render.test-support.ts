import { describe, expect, it } from "vitest";
import { renderIMessagePollBody } from "./poll-render.js";

const options = [
  { id: "a", text: "Red" },
  { id: "b", text: "Blue" },
];
const selection = (option_id: string, option_text: string) => ({
  participant: "+12065550123",
  option_id,
  option_text,
  event_type: "selected" as const,
});

describe("renderIMessagePollBody", () => {
  it("renders a created poll with numbered options", () => {
    const out = renderIMessagePollBody({
      kind: "created",
      question: "Favorite color?",
      options,
    });
    expect(out).toContain("Favorite color?");
    expect(out).toContain("1) Red");
    expect(out).toContain("2) Blue");
    expect(out).toContain("poll-vote");
    expect(out).toContain("\u{1F4CA} Poll");
  });

  it("renders stable option ids for Remote Mac accounts", () => {
    const out = renderIMessagePollBody(
      {
        kind: "created",
        question: "Favorite color?",
        options: [
          { id: "option-red", text: "Red" },
          { id: "option-blue", text: "Blue" },
        ],
      },
      undefined,
      { preferOptionId: true },
    );
    expect(out).toContain("Red (id: option-red)");
    expect(out).toContain("Blue (id: option-blue)");
    expect(out).toContain("pollOptionId = the stable option id shown above");
    expect(out).not.toContain("pollOptionIndex =");
  });

  it("folds in vote tallies", () => {
    const out = renderIMessagePollBody({
      kind: "created",
      options,
      votes: [
        { option_id: "b", event_type: "selected" },
        { option_id: "b", event_type: "selected" },
        { option_id: "a", event_type: "removed" },
      ],
    });
    expect(out).toContain("2) Blue [2]");
    expect(out).toContain("1) Red");
    expect(out).not.toContain("Red [");
  });

  it("renders a vote update", () => {
    const out = renderIMessagePollBody({
      kind: "vote",
      vote: { participant: "+12065550123", option_text: "Blue", event_type: "selected" },
    });
    expect(out).toContain("Poll vote");
    expect(out).toContain("Blue");
  });

  it("renders the full selection snapshot instead of a stale singular vote", () => {
    const out = renderIMessagePollBody({
      kind: "vote",
      vote: selection("a", "Lobster"),
      votes: [selection("a", "Lobster"), selection("b", "Also lobster")],
    });

    expect(out).toContain('currently selected "Lobster", "Also lobster"');
    expect(out).not.toContain('voted for "Lobster"');
  });

  it("does not report a remaining selection as a new vote", () => {
    const out = renderIMessagePollBody({
      kind: "vote",
      vote: selection("b", "Beta"),
      votes: [selection("b", "Beta")],
    });

    expect(out).toContain('currently selected "Beta"');
    expect(out).not.toContain('voted for "Beta"');
  });

  it("scopes an empty selection snapshot to the event sender", () => {
    const out = renderIMessagePollBody({ kind: "vote", votes: [] }, "+12065550123");

    expect(out).toBe("\u{1F4CA} Poll selections: +12065550123 currently selected no options");
  });

  it("returns null for a poll with no options and no vote", () => {
    expect(renderIMessagePollBody({ kind: "created", options: [] })).toBeNull();
  });
});
