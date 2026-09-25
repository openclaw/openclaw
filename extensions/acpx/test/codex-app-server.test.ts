import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it.each([false, true])(
  "settles an interrupted fixture turn before dispatching the next input line (empty answer first: %s)",
  (emptyAnswerFirst) => {
    const threadId = "thread-fixture";
    const successorAnswers = { answers: { question: { answers: ["successor"] } } };
    const requests = [
      { id: 1, method: "turn/start", params: { threadId } },
      ...(emptyAnswerFirst ? [{ id: "fixture-1", result: { answers: {} } }] : []),
      { id: 2, method: "turn/interrupt", params: { threadId, turnId: "turn-process-1" } },
      { id: 3, method: "turn/start", params: { threadId } },
      { id: "fixture-1", result: { answers: { question: { answers: ["stale"] } } } },
      { id: "fixture-2", result: successorAnswers },
    ];
    const output = execFileSync(
      process.execPath,
      [fileURLToPath(new URL("./fixtures/codex-app-server.mjs", import.meta.url))],
      {
        input: `${requests.map((request) => JSON.stringify(request)).join("\n")}\n`,
        encoding: "utf8",
        env: {},
        timeout: 5_000,
      },
    );
    const messages = output
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);

    expect(messages.filter((message) => typeof message.id === "number")).toMatchObject([
      { id: 1, result: { turn: { id: "turn-process-1" } } },
      { id: 2, result: {} },
      { id: 3, result: { turn: { id: "turn-process-2" } } },
    ]);
    expect(messages.filter((message) => message.method === "turn/completed")).toMatchObject([
      { params: { turn: { id: "turn-process-1", status: "interrupted" } } },
      { params: { turn: { id: "turn-process-2", status: "completed" } } },
    ]);
    const deltas = messages.filter((message) => message.method === "item/agentMessage/delta");
    expect(deltas).toHaveLength(1);
    expect(deltas[0]).toMatchObject({
      params: { turnId: "turn-process-2", delta: JSON.stringify(successorAnswers) },
    });
  },
);
