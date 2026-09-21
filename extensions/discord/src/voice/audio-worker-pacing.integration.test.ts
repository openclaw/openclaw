import { once } from "node:events";
import { MessageChannel, Worker } from "node:worker_threads";
import {
  resolveRuntimeWorkerArgv,
  resolveRuntimeWorkerUrl,
} from "openclaw/plugin-sdk/process-runtime";
import { describe, expect, it } from "vitest";
import { startDiscordPacingReceiver } from "./audio-starvation.test-support.js";
import { discordAudioTestEntrypoints } from "./audio-worker-entrypoints.test-support.js";

function launch(
  role: "producer" | "receiver",
  port: import("node:worker_threads").MessagePort,
  state: SharedArrayBuffer,
) {
  const url = resolveRuntimeWorkerUrl(discordAudioTestEntrypoints.pacing);
  return new Worker(url, {
    workerData: { runtime: "discord-audio-starvation-test", role, port, state },
    transferList: [port],
    execArgv: resolveRuntimeWorkerArgv(url).slice(0, -1),
  });
}
const delay = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
const maxGap = (times: number[]) => Math.max(...times.slice(1).map((time, i) => time - times[i]!));

async function measure(workerOwned: boolean): Promise<number[]> {
  const { port1, port2 } = new MessageChannel();
  const state = new SharedArrayBuffer(4);
  let local: ReturnType<typeof startDiscordPacingReceiver> | undefined;
  let receiver: Worker | undefined;
  let ready: Promise<unknown>;
  if (workerOwned) {
    receiver = launch("receiver", port1, state);
    ready = once(receiver, "message");
  } else {
    ready = new Promise<void>((resolve) => {
      local = startDiscordPacingReceiver(port1, state, resolve);
    });
  }
  const producer = launch("producer", port2, state);
  try {
    await ready;
    if (local) {
      expect(local.times.length, "ready means source audio is being consumed").toBeGreaterThan(0);
    }
    await delay(250);
    const until = performance.now() + 500;
    while (performance.now() < until) {
      /* deliberate main-thread starvation */
    }
    await delay(300);
    if (!receiver) {
      return [...local!.times];
    }
    const result = once(receiver, "message");
    // Node Worker has no browser targetOrigin.
    // oxlint-disable-next-line unicorn/require-post-message-target-origin
    receiver.postMessage({ type: "finish" });
    const [message] = await result;
    return (message as { times: number[] }).times;
  } finally {
    Atomics.store(new Int32Array(state), 0, 1);
    local?.close();
    await Promise.all([producer.terminate(), receiver?.terminate()]);
  }
}

describe("Discord worker packet preparation under Gateway starvation", () => {
  it("keeps continuous source audio flowing over the direct port while main is blocked", async () => {
    const before = await measure(false);
    const after = await measure(true);
    expect(before.length).toBeGreaterThan(15);
    expect(after.length).toBeGreaterThan(35);
    expect(maxGap(before)).toBeGreaterThan(450);
    expect(maxGap(after)).toBeLessThan(120);
  }, 20_000);
});
