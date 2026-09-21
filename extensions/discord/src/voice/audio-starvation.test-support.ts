import { isMainThread, parentPort, workerData, type MessagePort } from "node:worker_threads";
import { createRealtimeVoiceAudioPortSender } from "openclaw/plugin-sdk/realtime-voice-provider";
import { DISCORD_CONTINUOUS_CLOCK_BYTES } from "./audio-worker-protocol.js";
import { DiscordContinuousOutput } from "./continuous-output.runtime.js";
import { DiscordRealtimePlayer } from "./realtime-player.runtime.js";
import { loadDiscordVoiceSdk } from "./sdk-runtime.js";

export function startDiscordPacingReceiver(
  port: MessagePort,
  state: SharedArrayBuffer,
  started: () => void,
) {
  const sdk = loadDiscordVoiceSdk();
  const player = sdk.createAudioPlayer({
    behaviors: { noSubscriber: sdk.NoSubscriberBehavior.Play, maxMissedFrames: 100 },
  });
  const room = new DiscordRealtimePlayer(player);
  const times: number[] = [];
  player.on("stateChange", (_previous, next) => {
    if (next.status !== sdk.AudioPlayerStatus.Playing) {
      return;
    }
    const read = next.resource.read.bind(next.resource);
    next.resource.read = () => {
      const packet = read();
      // Count real encoded source audio, never SDK filler silence. This observes
      // the SDK's own 20 ms resource consumption, not a substitute test timer.
      if (packet && !packet.equals(Buffer.from([0xf8, 0xff, 0xfe]))) {
        times.push(performance.now());
        // Queuing playback can precede asynchronous encoder construction.
        if (times.length === 1) {
          started();
        }
      }
      return packet;
    };
  });
  const output = new DiscordContinuousOutput({
    id: 1,
    enabled: true,
    port,
    state: new Int32Array(state),
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
    times,
    close: () => {
      output.close();
      room.close();
    },
  };
}

if (!isMainThread && parentPort && workerData?.runtime === "discord-audio-starvation-test") {
  const control = parentPort;
  const data: { role: "producer" | "receiver"; port: MessagePort; state: SharedArrayBuffer } =
    workerData;
  if (data.role === "receiver") {
    const receiver = startDiscordPacingReceiver(data.port, data.state, () =>
      control.postMessage({ type: "playing" }, []),
    );
    control.on("message", () => {
      control.postMessage({ type: "result", times: receiver.times }, []);
      receiver.close();
      control.close();
    });
  } else {
    const sender = createRealtimeVoiceAudioPortSender(data);
    let sample = 0;
    const timer = setInterval(() => {
      const audio = Buffer.alloc(960);
      for (let i = 0; i < 480; i += 1) {
        audio.writeInt16LE(
          Math.round(Math.sin((sample++ * 2 * Math.PI * 440) / 24_000) * 12_000),
          i * 2,
        );
      }
      sender.sendAudio(audio);
    }, 20);
    control.on("message", () => {
      clearInterval(timer);
      sender.close();
      control.close();
    });
  }
}
