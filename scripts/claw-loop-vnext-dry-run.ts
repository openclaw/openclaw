import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  LoopTransport,
  SendMessageRequest,
  SendMessageResult,
} from "../src/claw-loop-vnext/transport/types.js";
import { nudgeIfStuck, sendCurrentPhasePrompt } from "../src/claw-loop-vnext/orchestrator.js";
import { RuntimeStore } from "../src/claw-loop-vnext/runtime-store.js";

class DemoPrimary implements LoopTransport {
  readonly kind = "sdk" as const;
  async sendMessage(_request: SendMessageRequest): Promise<SendMessageResult> {
    return { delivered: false, transport: "sdk", outputText: "", reason: "simulated-no-ack" };
  }
}

class DemoFallback implements LoopTransport {
  readonly kind = "tmux" as const;
  async sendMessage(_request: SendMessageRequest): Promise<SendMessageResult> {
    return {
      delivered: true,
      transport: "tmux",
      ackId: "demo-ack",
      outputText: "PHASE_COMPLETE: P1\nPHASE_COMPLETE: P1",
    };
  }
}

async function main() {
  const goalsDir = await mkdtemp(path.join(os.tmpdir(), "claw-loop-vnext-demo-"));
  const goalFile = path.join(goalsDir, "goal-demo.json");
  await writeFile(
    goalFile,
    JSON.stringify({
      title: "Demo goal",
      workdir: "/tmp",
      status: "pending",
      phases: [
        { id: "P1", name: "Plan", status: "pending" },
        { id: "P2", name: "Implement", status: "pending" },
      ],
      orchestration: { maxRetries: 2, ackTimeoutMs: 100 },
    }),
    "utf8",
  );

  const result = await sendCurrentPhasePrompt(
    { goalsDir, primaryTransport: new DemoPrimary(), fallbackTransport: new DemoFallback() },
    goalFile,
    "demo run",
  );

  const store = new RuntimeStore(path.join(goalsDir, ".runtime", "goal-demo.state.json"));
  const state = await store.load("goal-demo");
  state.lastActivityAt = new Date(Date.now() - 10 * 60_000).toISOString();
  await store.save(state);

  const nudge1 = await nudgeIfStuck({ goalsDir, primaryTransport: new DemoFallback() }, goalFile, {
    stuckAfterMs: 1_000,
    cooldownMs: 60_000,
  });
  const nudge2 = await nudgeIfStuck({ goalsDir, primaryTransport: new DemoFallback() }, goalFile, {
    stuckAfterMs: 1_000,
    cooldownMs: 60_000,
  });

  const goalText = await readFile(goalFile, "utf8");
  const events = await readFile(path.join(goalsDir, ".runtime", "goal-demo.events.jsonl"), "utf8");

  // eslint-disable-next-line no-console
  console.log("delivery", result.delivered, result.transport, result.ackId);
  // eslint-disable-next-line no-console
  console.log("signals", result.signals.map((s) => s.type).join(","));
  // eslint-disable-next-line no-console
  console.log("nudge", nudge1, nudge2);
  // eslint-disable-next-line no-console
  console.log("goal", goalText.trim());
  // eslint-disable-next-line no-console
  console.log("events", events.trim().split("\n").length);
}

await main();
