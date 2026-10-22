import type { CliBackendTurnInterrupt } from "openclaw/plugin-sdk/cli-backend";
import { afterEach, expect, it } from "vitest";
import {
  collectClaudeCli,
  createCliTestHarness,
  resultDetail,
} from "./cli-runtime.test-support.js";
import { executeClaudeCli } from "./cli.runtime.js";

const harness = createCliTestHarness("openclaw-claude-yield-");
afterEach(() => harness.cleanup());

it.each(["aborted_tools", "aborted_streaming"])(
  "interrupts %s through the control channel and reuses the warm session",
  async (terminalReason) => {
    let interrupt: CliBackendTurnInterrupt | undefined;
    const context = await harness.context(
      String.raw`
import assert from "node:assert/strict";
import { createInterface } from "node:readline";
const send = (value) => process.stdout.write(JSON.stringify(value) + "\n");
let turn = 0;
for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  if (message.type === "control_request") {
    assert.ok(message.request_id);
    assert.ok(["initialize", "interrupt"].includes(message.request.subtype));
    send({ type: "control_response", response: {
      subtype: "success", request_id: message.request_id, response: {},
    } });
    if (message.request.subtype === "interrupt") {
      assert.equal(turn, 1);
      send({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Late text" }] } });
      send({ type: "result", subtype: "error_during_execution", is_error: true,
        errors: ["No final response"], terminal_reason: process.env.TERMINAL_REASON,
        stop_reason: "tool_use", session_id: "fixture-session" });
    }
  } else {
    assert.equal(message.type, "user");
    turn++;
    if (turn === 1) send({ type: "system", subtype: "fixture_ready", pid: process.pid });
    else send({ type: "result", subtype: "success", is_error: false,
      session_id: "fixture-session", result: JSON.stringify({ pid: process.pid, turn }) });
  }
}
`,
      {
        liveSession: harness.liveSession(),
        registerTurnInterrupt: (value) => {
          interrupt = value;
        },
      },
      { TERMINAL_REASON: terminalReason },
    );
    const records: Record<string, unknown>[] = [];
    for await (const record of executeClaudeCli(context)) {
      records.push(record);
      if (record.subtype === "fixture_ready") {
        expect(interrupt).toBeDefined();
        await interrupt!.interrupt("yield");
      }
    }
    expect(records).toHaveLength(2);
    expect(records[1]).toMatchObject({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "",
    });
    const handle = context.liveSession!.current();
    expect(handle?.isIdle()).toBe(true);
    const resumed = resultDetail(
      await collectClaudeCli({ ...context, useResume: true, sessionId: "fixture-session" }),
    );
    expect(resumed).toEqual({ pid: records[0]?.pid, turn: 2 });
    expect(context.liveSession!.current()).toBe(handle);
  },
);
