import { expect, it } from "vitest";
import {
  buildPollResultsSummary,
  buildPollStartContent,
  formatPollResultsAsText,
  parsePollStart,
  resolvePollReferenceEventId,
} from "./poll-types.js";

const parsedPoll = {
  question: "Lunch?",
  kind: "m.poll.disclosed" as const,
  maxSelections: 1,
  answers: [
    { id: "a1", text: "Pizza" },
    { id: "a2", text: "Sushi" },
  ],
};

const vote = (
  sender: string,
  origin_server_ts: number | undefined,
  answers: string[],
  type = "m.poll.response",
  event_id = `$vote${origin_server_ts}`,
) => ({
  event_id,
  sender,
  origin_server_ts,
  type,
  content: { [type]: { answers } },
});

const wirePoll = {
  question: { "m.text": parsedPoll.question },
  kind: parsedPoll.kind,
  max_selections: 1,
  answers: parsedPoll.answers.map(({ id, text }) => ({ id, "m.text": text })),
};

it("parses legacy m.poll payloads", () => {
  expect(parsePollStart({ "m.poll": wirePoll })).toEqual(parsedPoll);
});

it("caps invalid remote max selections to the available answer count", () => {
  const parsed = parsePollStart({
    "m.poll.start": { ...wirePoll, kind: "m.poll.undisclosed", max_selections: 99 },
  });

  expect(parsed?.maxSelections).toBe(2);
});

it.each([
  { question: wirePoll.question, answers: "nope" },
  { question: { "m.text": 42 }, answers: wirePoll.answers },
])("rejects malformed poll content: %j", (poll) => {
  expect(parsePollStart({ "m.poll.start": poll } as never)).toBeNull();
});

it("keeps well-formed answers when other entries are malformed", () => {
  const parsed = parsePollStart({
    "m.poll.start": {
      ...wirePoll,
      answers: [
        null,
        { id: "a1", "m.text": "Yes" },
        { id: 42, "m.text": "dropped" },
        { id: "bad-text", "m.text": 42 },
      ],
    },
  } as never);

  expect(parsed?.answers).toEqual([{ id: "a1", text: "Yes" }]);
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

it("counts only the latest valid response from each sender", () => {
  const summary = buildPollResultsSummary({
    sender: "@alice:example.org",
    poll: parsedPoll,
    relationEvents: [
      vote("@bob:example.org", 1, ["a1"]),
      vote("@bob:example.org", 2, ["a2"]),
      vote("@carol:example.org", 3, []),
      vote("@dave:example.org", 4, ["a1"], "org.matrix.msc3381.poll.response"),
    ],
  });

  expect(summary?.entries).toEqual(parsedPoll.answers.map((answer) => ({ ...answer, votes: 1 })));
  expect(summary?.totalVotes).toBe(2);
});

it.each([
  { name: "nonfinite closing times", endTimes: [Number.NaN], closed: false },
  { name: "the earliest finite closing time", endTimes: [1, -0], closed: true },
])("preserves vote ordering with $name", ({ endTimes, closed }) => {
  const votes: Array<[string, number | undefined, string]> = [
    ["$z", Number.NaN, "a2"],
    ["$a", undefined, "a1"],
    ["$after", 0.5, "a1"],
    ["$equal", 0, "a2"],
    ["$before", -0.5, "a1"],
  ];
  const summary = buildPollResultsSummary({
    sender: "@alice:example.org",
    poll: parsedPoll,
    relationEvents: [
      ...endTimes.map((origin_server_ts, index) => ({
        event_id: "$end" + index,
        sender: "@alice:example.org",
        type: "m.poll.end",
        origin_server_ts,
      })),
      ...votes.map(([event_id, timestamp, answer]) =>
        vote("@bob:example.org", timestamp, [answer], undefined, event_id),
      ),
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
