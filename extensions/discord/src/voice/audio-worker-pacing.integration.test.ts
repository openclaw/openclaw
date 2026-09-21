import { MessageChannel, Worker } from "node:worker_threads";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import {
  resolveRuntimeWorkerArgv,
  resolveRuntimeWorkerUrl,
} from "openclaw/plugin-sdk/process-runtime";
import { describe, expect, it } from "vitest";
import {
  startDiscordPacingReceiver,
  type DiscordPacingFact,
} from "./audio-starvation.test-support.js";
import { discordAudioTestEntrypoints } from "./audio-worker-entrypoints.test-support.js";

const SOURCE_FRAMES = 50;
const WARMUP_FRAMES = 6;

function launch(
  role: "producer" | "receiver",
  port: import("node:worker_threads").MessagePort,
  state: SharedArrayBuffer,
) {
  const url = resolveRuntimeWorkerUrl(discordAudioTestEntrypoints.pacing);
  return new Worker(url, {
    workerData: {
      runtime: "discord-audio-starvation-test",
      role,
      port,
      state,
      frames: SOURCE_FRAMES,
      preroll: WARMUP_FRAMES,
    },
    transferList: [port],
    execArgv: resolveRuntimeWorkerArgv(url).slice(0, -1),
  });
}
const maxGap = (facts: DiscordPacingFact[]) =>
  Math.max(...facts.slice(1).map((fact, i) => fact.at - facts[i]!.at));

async function measure(workerOwned: boolean) {
  const { port1, port2 } = new MessageChannel();
  // The first word remains the production close fence; the second records starvation.
  const state = new SharedArrayBuffer(8);
  const shared = new Int32Array(state);
  const ready = createDeferred<void>();
  const consumed = createDeferred<void>();
  const acknowledged = createDeferred<DiscordPacingFact[]>();
  const failed = createDeferred<never>();
  const samples: DiscordPacingFact[] = [];
  const onPacket = (fact: DiscordPacingFact) => {
    samples.push(fact);
    if (samples.length === WARMUP_FRAMES) {
      ready.resolve();
    }
    if (samples.length === SOURCE_FRAMES) {
      consumed.resolve();
    }
  };
  let local: ReturnType<typeof startDiscordPacingReceiver> | undefined;
  let receiver: Worker | undefined;
  if (workerOwned) {
    receiver = launch("receiver", port1, state);
    receiver.on("message", onPacket);
    receiver.on("error", failed.reject);
  } else {
    local = startDiscordPacingReceiver(port1, state, onPacket);
  }
  const producer = launch("producer", port2, state);
  producer.once("message", acknowledged.resolve);
  producer.on("error", failed.reject);
  try {
    return await Promise.race([
      (async () => {
        await ready.promise;
        Atomics.store(shared, 1, 1);
        const until = performance.now() + 500;
        while (performance.now() < until) {
          /* deliberate main-thread starvation */
        }
        Atomics.store(shared, 1, 0);
        await consumed.promise;
        return { samples, acknowledged: await acknowledged.promise };
      })(),
      failed.promise,
    ]);
  } finally {
    Atomics.store(shared, 0, 1);
    local?.close();
    await Promise.all([producer.terminate(), receiver?.terminate()]);
  }
}

describe("Discord worker packet preparation under Gateway starvation", () => {
  it("keeps continuous source audio flowing over the direct port while main is blocked", async () => {
    const before = await measure(false);
    const after = await measure(true);
    for (const result of [before, after]) {
      expect(result.acknowledged).toHaveLength(SOURCE_FRAMES);
      expect(result.samples).toHaveLength(result.acknowledged.length);
    }
    expect(before.samples.some((fact) => fact.mainBlocked)).toBe(false);
    expect(after.samples.some((fact) => fact.mainBlocked)).toBe(true);
    expect(after.acknowledged.some((fact) => fact.mainBlocked)).toBe(true);
    expect(maxGap(before.samples)).toBeGreaterThan(450);
    expect(maxGap(after.samples)).toBeLessThan(120);
  }, 20_000);
});
