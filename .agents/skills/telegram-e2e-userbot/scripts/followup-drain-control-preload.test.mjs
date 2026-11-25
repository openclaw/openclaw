import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.ts";
import { run, stopChildren } from "./node-test-children.mjs";

// Leave time inside the harness's 120 s budget for after hooks to join children.
const TEST_TIMEOUT_MS = 90_000;

test(
  "holds one real callback invocation and releases it once",
  { timeout: TEST_TIMEOUT_MS },
  async (context) => {
    const children = new Set();
    const temporary = useAutoCleanupTempDirTracker((cleanup) =>
      context.after(async () => {
        await stopChildren(children);
        cleanup();
      }),
    );
    const root = temporary.make("followup-control-test-");
    const commandPath = path.join(root, "command.json");
    const statusPath = path.join(root, "status.json");
    const preload = fileURLToPath(new URL("./followup-drain-control-preload.mjs", import.meta.url));
    const script = `
      import fs from "node:fs";
      const commandPath = process.env.TELEGRAM_E2E_FOLLOWUP_CONTROL_COMMAND;
      const statusPath = process.env.TELEGRAM_E2E_FOLLOWUP_CONTROL_STATUS;
      const write = (value) => fs.writeFileSync(commandPath, JSON.stringify(value));
      const wait = async (seq) => {
        for (;;) {
          if (fs.existsSync(statusPath)) {
            const value = JSON.parse(fs.readFileSync(statusPath, "utf8"));
            if (value.seq === seq) return value;
          }
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      };
      const key = "agent:main:main";
      let calls = 0;
      const callbacks = new Map([[key, async () => { calls += 1; }]]);
      const run = { run: { sessionId: "session" } };
      globalThis[Symbol.for("openclaw.followupDrainCallbacks")] = callbacks;
      globalThis[Symbol.for("openclaw.followupQueues")] = new Map([[key, {
        draining: true, items: [run], inFlight: new Set([run]),
      }]]);
      write({ seq: 1, command: "arm", sessionKey: key });
      console.error("waiting for control seq 1 (arm)");
      await wait(1);
      const invocation = callbacks.get(key)(run);
      write({ seq: 2, command: "waitHeld" });
      console.error("waiting for control seq 2 (waitHeld)");
      const held = await wait(2);
      if (held.inFlight !== 1 || calls !== 0) throw new Error("callback was not held");
      write({ seq: 3, command: "release" });
      console.error("waiting for control seq 3 (release)");
      await wait(3);
      await invocation;
      if (calls !== 1) throw new Error("callback did not run exactly once");
    `;
    const result = await run(
      context,
      children,
      process.execPath,
      [`--import=${preload}`, "--input-type=module", "--eval", script],
      {
        env: {
          ...process.env,
          TELEGRAM_E2E_FOLLOWUP_CONTROL_COMMAND: commandPath,
          TELEGRAM_E2E_FOLLOWUP_CONTROL_STATUS: statusPath,
        },
      },
    );
    assert.equal(result.status, 0, result.stderr);
  },
);
