import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { CliBackendTurnInterrupt } from "openclaw/plugin-sdk/cli-backend";
import { afterEach, expect, it } from "vitest";
import {
  collectClaudeCli,
  createCliTestHarness,
  resultDetail,
  waitForProcessExit,
} from "./cli-runtime.test-support.js";
import { executeClaudeCli } from "./cli.runtime.js";

const harness = createCliTestHarness("openclaw-claude-yield-");
afterEach(() => harness.cleanup());

const fixture = String.raw`
import assert from "node:assert/strict";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
const nativeSessionId = process.env.NATIVE_SESSION_ID ?? "fixture-session";
const send = (value) => process.stdout.write(JSON.stringify(value) + "\n");
for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  if (message.type === "control_request") {
    send({ type: "control_response", response: {
      subtype: "success", request_id: message.request_id, response: {},
    } });
    if (message.request.subtype === "interrupt") {
      appendFileSync("native-history.txt", "[Request interrupted by user]\n");
      send({ type: "result", subtype: "error_during_execution", is_error: true,
        terminal_reason: "aborted_tools", session_id: nativeSessionId });
    }
  } else {
    assert.equal(message.type, "user");
    if (process.argv.includes("--resume") && !process.argv.includes("--fork-session")) {
      send({ type: "result", subtype: "success", is_error: false,
        session_id: nativeSessionId, result: JSON.stringify({
          pid: process.pid, resumed: true, history: readFileSync("native-history.txt", "utf8"),
        }) });
    } else {
      writeFileSync("native-history.txt", "accepted tool result\n");
      send({ type: "system", subtype: "init", session_id: nativeSessionId });
      send({ type: "system", subtype: "fixture_ready", pid: process.pid });
    }
  }
}
`;

it.each([
  { name: "fresh", inputId: "fixture-session", nativeId: "fixture-session", fork: false },
  { name: "forked", inputId: "parent-session", nativeId: "fork-session", fork: true },
])(
  "ends a $name yielded turn and resumes its native history",
  async ({ inputId, nativeId, fork }) => {
    let interrupt: CliBackendTurnInterrupt | undefined;
    const context = await harness.context(
      fixture,
      {
        sessionId: inputId,
        useResume: fork,
        liveSession: harness.liveSession(),
        registerTurnInterrupt: (value) => {
          interrupt = value;
        },
      },
      { NATIVE_SESSION_ID: nativeId },
    );
    if (fork) {
      context.args = [...context.args, "--fork-session"];
    }
    const records: Record<string, unknown>[] = [];
    for await (const record of executeClaudeCli(context)) {
      records.push(record);
      if (record.subtype === "fixture_ready") {
        expect(interrupt).toBeDefined();
        await interrupt!.interrupt("yield");
      }
    }
    expect(await readFile(path.join(context.cwd, "native-history.txt"), "utf8")).not.toContain(
      "[Request interrupted by user]",
    );
    expect(records.filter((record) => record.type === "result")).toEqual([
      expect.objectContaining({ subtype: "success", is_error: false, result: "" }),
    ]);
    expect(context.liveSession!.current()).toBeUndefined();
    expect(
      new Set(
        records.flatMap((record) =>
          typeof record.session_id === "string" ? [record.session_id] : [],
        ),
      ),
    ).toEqual(new Set([nativeId]));
    const nativePid = records.find((record) => record.subtype === "fixture_ready")?.pid;
    assert(typeof nativePid === "number");
    await waitForProcessExit([nativePid], AbortSignal.timeout(10_000));
    const resumed = resultDetail(
      await collectClaudeCli({
        ...context,
        sessionId: nativeId,
        args: context.args.filter((arg) => arg !== "--fork-session"),
        useResume: true,
      }),
    );
    expect(resumed.resumed).toBe(true);
    expect(resumed.pid).not.toBe(nativePid);
    expect(resumed.history).toBe("accepted tool result\n");
  },
);

it("keeps genuine cancellation an error without emitting a successful yield result", async () => {
  const controller = new AbortController();
  const context = await harness.context(fixture, {
    liveSession: harness.liveSession(),
    abortSignal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]),
  });
  const results: Record<string, unknown>[] = [];
  const run = async () => {
    for await (const record of executeClaudeCli(context)) {
      if (record.type === "result") {
        results.push(record);
      }
      if (record.subtype === "fixture_ready") {
        controller.abort(new Error("genuine user cancellation"));
      }
    }
  };
  await expect(run()).rejects.toThrow("genuine user cancellation");
  expect(results).toEqual([]);
  expect(context.liveSession!.current()).toBeUndefined();
});
