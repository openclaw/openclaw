import { writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { createLocalMeetingRealtimeAudioTransport } from "../src/meeting-bot/realtime-local-audio-transport.js";

const child = [
  "const value = Buffer.from('runtime-after-exit 你\\n', 'utf8');",
  "process.stderr.write(value.subarray(0, value.length - 2));",
  "process.stderr.write(value.subarray(value.length - 2));",
  "process.exit(0);",
].join("");
const inputChild = "setTimeout(() => process.exit(0), 20);";
const logs: string[] = [];
const transport = createLocalMeetingRealtimeAudioTransport({
  inputCommand: [process.execPath, "-e", inputChild],
  outputCommand: [process.execPath, "-e", child],
  bargeInRmsThreshold: 1,
  bargeInPeakThreshold: 1,
  bargeInCooldownMs: 1,
  logger: {
    debug: (message) => logs.push(message),
    info: () => {},
    warn: () => {},
    error: () => {},
  },
  logScope: "[meeting-runtime]",
});

for (let attempt = 0; attempt < 50; attempt += 1) {
  if (logs.some((line) => line.includes("runtime-after-exit 你"))) {
    break;
  }
  await delay(20);
}
await transport.dispose();
const observed = logs.find((line) => line.includes("runtime-after-exit 你"));
if (!observed) {
  throw new Error(`missing complete child-process stderr diagnostic: ${JSON.stringify(logs)}`);
}
const evidencePath = process.env.DAILY_FIX_RUNTIME_PROOF_EVIDENCE;
if (!evidencePath) {
  throw new Error("DAILY_FIX_RUNTIME_PROOF_EVIDENCE is required");
}
await writeFile(
  evidencePath,
  `${JSON.stringify(
    {
      kind: "openclaw.meeting-audio-child-process-runtime-proof.v1",
      observed,
      runtime_kind: "child_process",
      near_real: true,
      issue_path: "local meeting audio bridge stderr after child exit",
    },
    null,
    2,
  )}\n`,
  "utf8",
);
console.log(observed);
