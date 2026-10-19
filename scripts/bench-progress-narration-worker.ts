import assert from "node:assert/strict";
import { mock } from "node:test";
import { setImmediate } from "node:timers/promises";
import type { InternalGetReplyOptions } from "../src/auto-reply/reply/get-reply.types.js";
import { attachProgressNarratorToReplyOptions } from "../src/auto-reply/reply/progress-narrator.js";
import { narrationFixture } from "./lib/bench-narration-model.js";
import { runBenchmarkEntrypoint } from "./lib/benchmark-harness.mts";

const EPOCH = 1_700_000_000_000;
const scenarios = ["burst", "quiet-tail", "urgent", "stop", "abort", "next-turn"] as const;

export async function benchmarkProgressNarration() {
  const results = [];
  for (const scenario of scenarios) {
    mock.timers.enable({ apis: ["Date", "setTimeout"], now: EPOCH });
    narrationFixture.preparations = 0;
    narrationFixture.active = 0;
    narrationFixture.maxActive = 0;
    narrationFixture.inputs = [];
    narrationFixture.blocked = undefined;
    const controller = new AbortController();
    const updates: Array<{ text: string; simulatedAtMs: number }> = [];
    const lifecycleRef: {
      current?: Parameters<NonNullable<InternalGetReplyOptions["onProgressNarratorLifecycle"]>>[0];
    } = {};
    let offered = 0;
    let forwarded = 0;
    let release = () => {};
    const options = attachProgressNarratorToReplyOptions({
      cfg: { agents: { defaults: { utilityModel: "benchmark/narrator" } } },
      agentId: "main",
      userMessage: "Inspect the synthetic files.",
      opts: {
        abortSignal: controller.signal,
        onProgressNarratorLifecycle: (value) => {
          lifecycleRef.current = value;
        },
        onNarrationUpdate: ({ text }) => {
          updates.push({ text, simulatedAtMs: Date.now() });
        },
        onToolStart: () => {
          forwarded++;
        },
        onCommandOutput: () => {
          forwarded++;
        },
      },
    });
    const lifecycle = lifecycleRef.current;
    assert(options?.onToolStart && options.onCommandOutput && lifecycle);
    const read = async (name: string) => {
      offered++;
      await options.onToolStart?.({ name: "read", phase: "start", args: { path: name } });
    };
    // Detached narration continuations settle on a real event-loop turn. The
    // supervisor's process timeout remains real even while cadence is simulated.
    const settle = async () => {
      await setImmediate();
    };
    const advance = async (ms: number) => {
      mock.timers.tick(ms);
      await settle();
    };
    try {
      const blocked = scenario === "urgent" || scenario === "stop" || scenario === "abort";
      if (blocked) {
        narrationFixture.blocked = new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      await read("initial.txt");
      await settle();
      assert.equal(narrationFixture.inputs.length, 1);
      assert.equal(forwarded, 1);
      const foregroundCompletedWhileBlocked = blocked && narrationFixture.active === 1;
      if (blocked) {
        assert(foregroundCompletedWhileBlocked);
      }

      if (scenario === "burst") {
        for (let group = 1; group <= 10; group++) {
          await advance(500);
          for (let index = 1; index <= 4; index++) {
            await read(`burst-${group}-${index}.txt`);
          }
          await settle();
        }
        await advance(6_999);
        await advance(1);
      } else if (scenario === "quiet-tail") {
        await advance(500);
        await read("quiet-tail.txt");
        await settle();
        await advance(11_499);
        await advance(1);
      } else if (scenario === "urgent") {
        offered++;
        await options.onCommandOutput({
          name: "exec",
          title: "synthetic failure",
          phase: "end",
          exitCode: 1,
        });
        assert.equal(narrationFixture.inputs.length, 1);
        narrationFixture.blocked = undefined;
        release();
        await settle();
        assert.equal(narrationFixture.inputs.length, 2);
        assert(
          narrationFixture.inputs[1]?.activityNotes.some((note) =>
            note.includes("synthetic failure"),
          ),
        );
        assert.equal(narrationFixture.inputs[1]?.simulatedAtMs, EPOCH);
      } else if (scenario === "next-turn") {
        lifecycle.beginTurn();
        await read("next-turn.txt");
        await settle();
        assert.equal(narrationFixture.inputs.length, 2);
        assert.equal(narrationFixture.inputs[1]?.userMessage, "");
        assert(
          !narrationFixture.inputs[1]?.activityNotes.some((note) => note.includes("initial.txt")),
        );
      } else {
        await read("pending.txt");
        if (scenario === "abort") {
          controller.abort();
        } else {
          lifecycle.stopTurn();
        }
        narrationFixture.blocked = undefined;
        release();
        await settle();
        assert.equal(updates.length, 0);
      }

      assert.equal(offered, forwarded);
      assert.equal(narrationFixture.active, 0);
      assert.equal(narrationFixture.maxActive, 1);
      const generations = narrationFixture.inputs.length;
      const updatesBeforeStop = updates.length;
      lifecycle.stopTurn();
      await advance(12_000);
      await advance(12_001);
      assert.equal(narrationFixture.inputs.length, generations);
      assert.equal(updates.length, updatesBeforeStop);
      results.push({
        scenario,
        offered,
        forwarded,
        preparations: narrationFixture.preparations,
        generations,
        maxInFlight: narrationFixture.maxActive,
        foregroundCompletedWhileBlocked,
        inputs: narrationFixture.inputs.map((input) => ({
          ...input,
          simulatedAtMs: input.simulatedAtMs - EPOCH,
        })),
        updates: updates.map((update) => ({
          ...update,
          simulatedAtMs: update.simulatedAtMs - EPOCH,
        })),
        generationsAfterStop: narrationFixture.inputs.length - generations,
        updatesAfterStop: updates.length - updatesBeforeStop,
      });
    } finally {
      lifecycle.stopTurn();
      controller.abort();
      release();
      await settle();
      mock.timers.reset();
    }
  }
  return { workload: "progress-narration", scenarios: results };
}

if (import.meta.main) {
  await runBenchmarkEntrypoint("bench-progress-narration-worker", async () => {
    console.log(
      `[bench-progress-narration-result] ${JSON.stringify(await benchmarkProgressNarration())}`,
    );
  });
}
