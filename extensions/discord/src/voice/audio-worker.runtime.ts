import { parentPort, workerData } from "node:worker_threads";
import {
  serializeDiscordAudioError,
  type DiscordAudioCommand,
  type DiscordAudioEvent,
  type DiscordAudioWorkerOptions,
} from "./audio-worker-protocol.js";
import { DiscordAudioWorker } from "./audio-worker.js";

const port = parentPort;
if (!port) {
  throw new Error("Discord audio runtime requires a worker MessagePort.");
}
const options: DiscordAudioWorkerOptions = workerData;
const media = new DiscordAudioWorker(options, (event: DiscordAudioEvent) => {
  port.postMessage(event);
  if (event.type === "stopped") {
    port.close();
  }
});
const fail = (error: unknown) => {
  port.postMessage({
    type: "error",
    error: serializeDiscordAudioError(error),
  } satisfies DiscordAudioEvent);
  void media.stop();
};
port.on("message", (command: DiscordAudioCommand) => {
  try {
    media.receive(command);
  } catch (error) {
    fail(error);
  }
});
port.on("close", () => {
  void media.stop();
});
void media.connect().catch(fail);
