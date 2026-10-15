import { isMainThread, parentPort, workerData, type MessagePort } from "node:worker_threads";
import { createRealtimeVoiceAudioPortSender } from "openclaw/plugin-sdk/realtime-voice-provider";
import { DISCORD_CONTINUOUS_CLOCK_BYTES } from "./audio-worker-protocol.js";
import { DiscordContinuousOutput } from "./continuous-output.runtime.js";
import { DiscordRealtimePlayer } from "./realtime-player.runtime.js";
import { loadDiscordVoiceSdk } from "./sdk-runtime.js";

export type DiscordPacingFact = { mainBlocked: boolean };
const pacingFact = (state: Int32Array): DiscordPacingFact => ({
  mainBlocked: Atomics.load(state, 1) === 1,
});

export function startDiscordPacingReceiver(
  port: MessagePort,
  state: SharedArrayBuffer,
  onPacket: (fact: DiscordPacingFact) => void,
) {
  const shared = new Int32Array(state);
  const sdk = loadDiscordVoiceSdk();
  const player = sdk.createAudioPlayer({
    behaviors: { noSubscriber: sdk.NoSubscriberBehavior.Play, maxMissedFrames: 100 },
  });
  const room = new DiscordRealtimePlayer(player);
  player.on("stateChange", (_previous, next) => {
    if (next.status !== sdk.AudioPlayerStatus.Playing) {
      return;
    }
    const read = next.resource.read.bind(next.resource);
    next.resource.read = () => {
      const packet = read();
      // Count real encoded source audio, never SDK filler silence. Each consumed
      // packet grants source credit; host scheduling cannot discard fixture ticks.
      if (packet && !packet.equals(Buffer.from([0xf8, 0xff, 0xfe]))) {
        onPacket(pacingFact(shared));
        port.postMessage({ type: "consumed" }, []);
      }
      return packet;
    };
  });
  const output = new DiscordContinuousOutput({
    id: 1,
    enabled: true,
    port,
    state: shared,
    clock: new BigInt64Array(new SharedArrayBuffer(DISCORD_CONTINUOUS_CLOCK_BYTES)),
    player: room,
    logContext: "synthetic-starvation-proof",
    post: (event) => {
      if (event.type === "continuous-error") {
        throw new Error(event.error.message);
      }
    },
  });
  return {
    close: () => {
      output.close();
      room.close();
    },
  };
}

if (!isMainThread && parentPort && workerData?.runtime === "discord-audio-starvation-test") {
  const control = parentPort;
  const data: {
    role: "producer" | "receiver";
    port: MessagePort;
    state: SharedArrayBuffer;
    frames: number;
    preroll: number;
  } = workerData;
  if (data.role === "receiver") {
    startDiscordPacingReceiver(data.port, data.state, (fact) => control.postMessage(fact, []));
  } else {
    const sender = createRealtimeVoiceAudioPortSender(data);
    const shared = new Int32Array(data.state);
    const acknowledged: DiscordPacingFact[] = [];
    let credits = data.preroll;
    let sent = 0;
    let inFlight = false;
    let sample = 0;
    const send = () => {
      if (inFlight || credits === 0 || sent === data.frames || Atomics.load(shared, 0) !== 0) {
        return;
      }
      const audio = Buffer.alloc(960);
      for (let i = 0; i < 480; i += 1) {
        audio.writeInt16LE(
          Math.round(Math.sin((sample++ * 2 * Math.PI * 440) / 24_000) * 12_000),
          i * 2,
        );
      }
      credits -= 1;
      sent += 1;
      inFlight = true;
      sender.sendAudio(audio);
    };
    data.port.on("message", (message: { type: "ack" | "consumed" }) => {
      if (message.type === "ack") {
        inFlight = false;
        acknowledged.push(pacingFact(shared));
        if (acknowledged.length === data.frames) {
          control.postMessage(acknowledged, []);
        }
      } else {
        credits += 1;
      }
      send();
    });
    send();
  }
}
