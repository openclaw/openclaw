import { describe, expect, it } from "vitest";
import {
  buildPollResultsSummary,
  buildPollResponseContent,
  buildPollStartContent,
  formatPollResultsAsText,
  parsePollStart,
  resolvePollReferenceEventId,
} from "./poll-types.js";

function makePoll(answers = ["a1", "a2"]) {
  return {
    question: "Lunch?",
    kind: "m.poll.disclosed" as const,
    maxSelections: 1,
    answers: answers.map((id, index) => ({ id, text: index === 0 ? "Pizza" : "Sushi" })),
  };
}

function vote(
  sender: string,
  origin_server_ts: number,
  answers: string[],
  type = "m.poll.response",
) {
  return {
    event_id: `$vote${origin_server_ts}`,
    sender,
    origin_server_ts,
    type,
    content: {
      [type]: { answers },
      "m.relates_to": { rel_type: "m.reference", event_id: "$poll" },
    },
  };
}

function wirePoll(
  ids: string[],
  overrides: Partial<NonNullable<Parameters<typeof parsePollStart>[0]["m.poll.start"]>> = {},
) {
  return {
    question: { "m.text": "Lunch?" },
    kind: "m.poll.disclosed" as const,
    max_selections: 1,
    answers: ids.map((id, index) => ({ id, "m.text": index === 0 ? "Yes" : "No" })),
    ...overrides,
  };
}

describe("parsePollStart", () => {
  it("parses legacy m.poll payloads", () => {
    const summary = parsePollStart({
      "m.poll": wirePoll(["answer1", "answer2"]),
    });

    expect(summary?.question).toBe("Lunch?");
    expect(summary?.answers).toEqual([
      { id: "answer1", text: "Yes" },
      { id: "answer2", text: "No" },
    ]);
  });

  it("caps invalid remote max selections to the available answer count", () => {
    const parsed = parsePollStart({
      "m.poll.start": wirePoll(["a1", "a2"], { kind: "m.poll.undisclosed", max_selections: 99 }),
    });

    expect(parsed?.maxSelections).toBe(2);
  });

  it("drops malformed answers instead of throwing on sender-controlled content", () => {
    const malformed: Array<[string, unknown]> = [
      ["answers is a string", "nope"],
      ["answers entries null", [null]],
      ["answer id non-string", [{ id: 42, "m.text": "a" }]],
      ["answer text non-string", [{ id: "a1", "m.text": 42 }]],
    ].map(([label, answers]) => [String(label), { question: { "m.text": "Q?" }, answers }]);
    malformed.push([
      "question text non-string",
      { question: { "m.text": 42 }, answers: [{ id: "a1", "m.text": "a" }] },
    ]);
    for (const [label, poll] of malformed) {
      expect(() => parsePollStart({ "m.poll.start": poll } as never), label).not.toThrow();
      expect(parsePollStart({ "m.poll.start": poll } as never), label).toBeNull();
    }
  });

  it("keeps well-formed answers when other entries are malformed", () => {
    const parsed = parsePollStart({
      "m.poll.start": {
        question: { "m.text": "Lunch?" },
        answers: [null, { id: "a1", "m.text": "Yes" }, { id: 42, "m.text": "dropped" }],
      },
    } as never);

    expect(parsed?.answers).toEqual([{ id: "a1", text: "Yes" }]);
  });
});

it("buildPollStartContent: preserves the requested multiselect cap instead of widening to all answers", () => {
  const content = buildPollStartContent({
    question: " Lunch? ",
    options: [" Pizza ", " ", "Sushi", "Tacos"],
    maxSelections: 2,
  });

  expect(content["m.poll.start"]?.max_selections).toBe(2);
  expect(content["m.poll.start"]?.kind).toBe("m.poll.undisclosed");
  expect(content["m.text"]).toBe("Lunch?\n1. Pizza\n2. Sushi\n3. Tacos");
  expect(content["org.matrix.msc1767.text"]).toBe("Lunch?\n1. Pizza\n2. Sushi\n3. Tacos");
});

it("poll relation parsing: extracts poll relation targets", () => {
  expect(
    resolvePollReferenceEventId({
      "m.relates_to": { rel_type: "m.reference", event_id: "$poll" },
    }),
  ).toBe("$poll");
});

describe("buildPollResultsSummary", () => {
  it("counts only the latest valid response from each sender", () => {
    const summary = buildPollResultsSummary({
      sender: "@alice:example.org",
      poll: makePoll(),
      relationEvents: [
        vote("@bob:example.org", 1, ["a1"]),
        vote("@bob:example.org", 2, ["a2"]),
        vote("@carol:example.org", 3, []),
        vote("@dave:example.org", 4, ["a1"], "org.matrix.msc3381.poll.response"),
      ],
    });

    expect(summary?.entries).toEqual([
      { id: "a1", text: "Pizza", votes: 1 },
      { id: "a2", text: "Sushi", votes: 1 },
    ]);
    expect(summary?.totalVotes).toBe(2);
  });

  it.each([
    { name: "nonfinite closing times", endTimes: [Number.NaN], closed: false },
    { name: "the earliest finite closing time", endTimes: [1, -0], closed: true },
  ])("preserves vote ordering with $name", ({ endTimes, closed }) => {
    const votes: Array<[string, number | undefined, string]> = [
      ["$z", Number.NaN, "answer2"],
      ["$a", undefined, "answer1"],
      ["$after", 0.5, "answer1"],
      ["$equal", 0, "answer2"],
      ["$before", -0.5, "answer1"],
    ];
    const summary = buildPollResultsSummary({
      sender: "@alice:example.org",
      poll: makePoll(["answer1", "answer2"]),
      relationEvents: [
        ...endTimes.map((origin_server_ts, index) => ({
          event_id: "$end" + index,
          sender: "@alice:example.org",
          type: "m.poll.end",
          origin_server_ts,
        })),
        ...votes.map(([event_id, origin_server_ts, answer]) => ({
          event_id,
          sender: "@bob:example.org",
          type: "m.poll.response",
          origin_server_ts,
          content: buildPollResponseContent("$poll", [answer]),
        })),
      ],
    });

    expect(summary?.entries.map(({ votes: voteCount }) => voteCount)).toEqual([0, 1]);
    expect(summary?.closed).toBe(closed);
  });

  it("formats disclosed poll results with vote totals", () => {
    const text = formatPollResultsAsText({
      question: "Lunch?",
      kind: "m.poll.disclosed",
      entries: [
        { id: "a1", text: "Pizza", votes: 1 },
        { id: "a2", text: "Sushi", votes: 0 },
      ],
      totalVotes: 1,
      closed: false,
    });

    expect(text).toContain("1. Pizza (1 vote)");
    expect(text).toContain("Total voters: 1");
  });
});
