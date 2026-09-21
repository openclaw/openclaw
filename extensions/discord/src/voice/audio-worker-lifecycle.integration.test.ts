import { once } from "node:events";
import { Worker } from "node:worker_threads";
import { GatewayOpcodes } from "discord-api-types/v10";
import {
  resolveRuntimeWorkerArgv,
  resolveRuntimeWorkerUrl,
} from "openclaw/plugin-sdk/process-runtime";
import { expect, it } from "vitest";
import { discordAudioTestEntrypoints } from "./audio-worker-entrypoints.test-support.js";
import type { DiscordAudioEvent, DiscordAudioWorkerOptions } from "./audio-worker-protocol.js";

it("exits cooperatively when stopped during the real SDK connection wait", async () => {
  const url = resolveRuntimeWorkerUrl(discordAudioTestEntrypoints.lifecycle);
  const worker = new Worker(url, {
    execArgv: resolveRuntimeWorkerArgv(url).slice(0, -1),
    workerData: {
      guildId: "1",
      channelId: "2",
      group: "worker-cancellation-test",
      selfDeaf: false,
      selfMute: false,
      connectTimeoutMs: 30_000,
      reconnectGraceMs: 15_000,
      captureSilenceGraceMs: 2_000,
      realtime: true,
    } satisfies DiscordAudioWorkerOptions,
  });
  const events: DiscordAudioEvent[] = [];
  const joined = new Promise<void>((resolve, reject) => {
    worker.on("error", reject);
    worker.on("message", (event: DiscordAudioEvent) => {
      events.push(event);
      if (
        event.type === "gateway-send" &&
        event.payload.op === GatewayOpcodes.VoiceStateUpdate &&
        event.payload.d.channel_id === "2"
      ) {
        resolve();
      }
      if (event.type === "error") {
        reject(new Error(event.error.message));
      }
    });
  });
  const exited = once(worker, "exit");
  try {
    await joined;
    // Node Worker has no browser targetOrigin.
    // oxlint-disable-next-line unicorn/require-post-message-target-origin
    worker.postMessage({ type: "stop" });
    expect(await exited).toEqual([0]);
    expect(events).toContainEqual({ type: "gateway-destroy" });
    expect(events).toContainEqual({ type: "stopped" });
    expect(events.some((event) => event.type === "error")).toBe(false);
    expect(
      events.some(
        (event) =>
          event.type === "gateway-send" &&
          event.payload.op === GatewayOpcodes.VoiceStateUpdate &&
          event.payload.d.channel_id === null,
      ),
    ).toBe(true);
  } finally {
    await worker.terminate();
  }
}, 10_000);
