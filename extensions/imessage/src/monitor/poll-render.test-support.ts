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
const created = (
  overrides: Partial<Parameters<typeof renderIMessagePollBody>[0]> = {},
  renderOptions?: Parameters<typeof renderIMessagePollBody>[2],
) => renderIMessagePollBody({ kind: "created", options, ...overrides }, undefined, renderOptions);
const expectParts = (body: string | null, parts: string[]) => {
  for (const part of parts) {
    expect(body).toContain(part);
  }
};

describe("renderIMessagePollBody", () => {
  it("renders a created poll with numbered options", () => {
    expectParts(created({ question: "Favorite color?" }), [
      "Favorite color?",
      "1) Red",
      "2) Blue",
      "poll-vote",
      "\u{1F4CA} Poll",
    ]);
  });

  it("renders stable option ids for Remote Mac accounts", () => {
    const out = created(
      { options: options.map(({ text }) => ({ id: `option-${text.toLowerCase()}`, text })) },
      { preferOptionId: true },
    );
    expectParts(out, [
      "Red (id: option-red)",
      "Blue (id: option-blue)",
      "pollOptionId = the stable option id shown above",
    ]);
    expect(out).not.toContain("pollOptionIndex =");
  });

  it("folds in vote tallies", () => {
    const out = created({
      votes: [
        { option_id: "b", event_type: "selected" },
        { option_id: "b", event_type: "selected" },
        { option_id: "a", event_type: "removed" },
      ],
    });
    expectParts(out, ["2) Blue [2]", "1) Red"]);
    expect(out).not.toContain("Red [");
  });

  it("renders a vote update", () => {
    const out = renderIMessagePollBody({
      kind: "vote",
      vote: { participant: "+12065550123", option_text: "Blue", event_type: "selected" },
    });
    expectParts(out, ["Poll vote", "Blue"]);
  });

  it.each([
    [[selection("a", "Lobster"), selection("b", "Also lobster")], '"Lobster", "Also lobster"'],
    [[selection("b", "Beta")], '"Beta"'],
  ] as const)(
    "renders the full selection snapshot, not a new singular vote: %j",
    (votes, expected) => {
      const out = renderIMessagePollBody({
        kind: "vote",
        vote: votes[0],
        votes: [...votes],
      });
      expect(out).toContain(`currently selected ${expected}`);
      expect(out).not.toContain(`voted for "${votes[0].option_text}"`);
    },
  );

  it("scopes an empty selection snapshot to the event sender", () => {
    const out = renderIMessagePollBody({ kind: "vote", votes: [] }, "+12065550123");

    expect(out).toBe("\u{1F4CA} Poll selections: +12065550123 currently selected no options");
  });

  it("returns null for a poll with no options and no vote", () => {
    expect(created({ options: [] })).toBeNull();
  });
});
