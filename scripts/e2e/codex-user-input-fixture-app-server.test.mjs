import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { afterEach, describe, it } from "node:test";

const fixturePath = new URL("./codex-user-input-fixture-app-server.mjs", import.meta.url);

const children = new Set();

afterEach(() => {
  for (const child of children) {
    child.kill("SIGKILL");
  }
  children.clear();
});

function startFixture() {
  const child = spawn(process.execPath, [fixturePath.pathname, "--scenario", "user-input-other"], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  children.add(child);
  const lines = [];
  let buffered = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffered += chunk;
    for (;;) {
      const index = buffered.indexOf("\n");
      if (index < 0) {
        break;
      }
      const line = buffered.slice(0, index).trim();
      buffered = buffered.slice(index + 1);
      if (line) {
        lines.push(JSON.parse(line));
      }
    }
  });
  return {
    child,
    write(message) {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    },
    async nextMessage(predicate) {
      const started = Date.now();
      for (;;) {
        const index = lines.findIndex(predicate);
        if (index >= 0) {
          return lines.splice(index, 1)[0];
        }
        if (Date.now() - started > 2_000) {
          throw new Error(`timed out waiting for fixture message; saw ${JSON.stringify(lines)}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    },
  };
}

describe("codex user input fixture app-server", () => {
  it("requests typed user input and completes with the returned answer", async () => {
    const fixture = startFixture();

    fixture.write({ id: 1, method: "initialize", params: {} });
    assert.equal(
      (await fixture.nextMessage((message) => message.id === 1)).result.serverInfo.name,
      "openclaw-qa-codex-fixture",
    );

    fixture.write({ id: 2, method: "thread/start", params: { cwd: "/tmp/openclaw-qa" } });
    assert.equal(
      (await fixture.nextMessage((message) => message.id === 2)).result.thread.id,
      "qa-thread-1",
    );

    fixture.write({ id: 3, method: "turn/start", params: { threadId: "qa-thread-1" } });
    assert.equal(
      (await fixture.nextMessage((message) => message.id === 3)).result.turn.id,
      "qa-turn-1",
    );

    const request = await fixture.nextMessage(
      (message) => message.method === "item/tool/requestUserInput",
    );
    assert.equal(request.params.threadId, "qa-thread-1");
    assert.equal(request.params.turnId, "qa-turn-1");
    assert.equal(request.params.questions[0].isOther, true);

    fixture.write({
      id: request.id,
      result: {
        answers: {
          custom: { answers: ["typed-live-answer"] },
        },
      },
    });

    const assistant = await fixture.nextMessage((message) => message.method === "item/completed");
    assert.match(assistant.params.item.text, /OPENCLAW_QA_CODEX_USER_INPUT_OK typed-live-answer/u);
    assert.equal(
      (await fixture.nextMessage((message) => message.method === "turn/completed")).params.turn
        .status,
      "completed",
    );
  });
});
