import { execFileSync, spawn, spawnSync } from "node:child_process";
import { accessSync, constants } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import WebSocket from "ws";

export const DEFAULT_MODEL = "gpt-realtime-2.1";
export const DEFAULT_VOICE = "marin";
export const OPENCLAW_FEED_DEVICE = "OpenClaw-Feed";
// Realtime can generate speech faster than Core Audio plays it. Keep enough
// headroom for a normal reply while still bounding a genuinely stalled sink.
export const MAX_PLAYBACK_BUFFERED_BYTES = 2 * 1024 * 1024;
export const MAX_WEBSOCKET_BUFFERED_BYTES = 512 * 1024;
export const OUTPUT_LATENCY_BUDGET_MS = 100;
export const DEFAULT_INSTRUCTIONS =
  "You are speaking to someone on a private FaceTime call. Be warm, concise, and conversational. Never claim to be human. If asked, clearly say you are an AI assistant.";

const here = path.dirname(fileURLToPath(import.meta.url));
const defaultCaptureBinary = path.join(
  here,
  "native",
  ".build",
  "release",
  "facetime-audio-capture",
);

export function parseArguments(raw) {
  const args = raw[0] === "--" ? raw.slice(1) : raw;
  const options = {
    captureBinary: process.env.FACETIME_CAPTURE_BINARY || defaultCaptureBinary,
    doctor: false,
    instructions: process.env.FACETIME_REALTIME_INSTRUCTIONS || DEFAULT_INSTRUCTIONS,
    model: process.env.OPENAI_REALTIME_MODEL || DEFAULT_MODEL,
    outputDevice: process.env.FACETIME_OUTPUT_DEVICE,
    preflight: false,
    voice: process.env.OPENAI_REALTIME_VOICE || DEFAULT_VOICE,
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--doctor") {
      options.doctor = true;
      continue;
    }
    if (argument === "--preflight") {
      options.preflight = true;
      continue;
    }
    const next = args[index + 1];
    if (
      ["--capture-binary", "--instructions", "--model", "--output-device", "--voice"].includes(
        argument,
      )
    ) {
      if (!next) {
        throw new Error(`${argument} requires a value`);
      }
      const key = {
        "--capture-binary": "captureBinary",
        "--instructions": "instructions",
        "--model": "model",
        "--output-device": "outputDevice",
        "--voice": "voice",
      }[argument];
      options[key] = next;
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }
  return options;
}

export function parseBridgeOutputDevices(systemProfilerOutput) {
  const devices = [];
  for (const line of systemProfilerOutput.split(/\r?\n/u)) {
    const match = line.match(/^\s{8}((?:.*BlackHole[^:]*|OpenClaw-Feed)):\s*$/iu);
    if (match) {
      devices.push(match[1].trim());
    }
  }
  return [...new Set(devices)];
}

export function chooseOutputDevice(devices) {
  return (
    devices.find((device) => device === OPENCLAW_FEED_DEVICE) ??
    devices.find((device) => /^BlackHole 2ch$/iu.test(device)) ??
    devices.find((device) => /^BlackHole \d+ch$/iu.test(device)) ??
    devices[0]
  );
}

export function resolveOutputDevice(requestedDevice, devices) {
  const selectedDevice = requestedDevice || chooseOutputDevice(devices);
  if (!selectedDevice) {
    throw new Error(
      "No bridge output device was found. Install OpenClawBridge or BlackHole and restart Core Audio.",
    );
  }
  if (!devices.includes(selectedDevice)) {
    throw new Error(`Bridge output device not found: ${selectedDevice}`);
  }
  return selectedDevice;
}

export function findAudioRouteProblems({ bridgeOutputDevice, input, output }) {
  const problems = [];
  const usesPairedDriver = bridgeOutputDevice === OPENCLAW_FEED_DEVICE;
  if (usesPairedDriver) {
    // FaceTime and Phone overrides are app-owned and unavailable through the
    // public Core Audio default-device API. Their route is a manual check.
    return problems;
  }
  if (input?.name !== bridgeOutputDevice) {
    problems.push(
      `System input is ${input?.name || "unknown"}; set it to ${bridgeOutputDevice} so FaceTime receives model speech.`,
    );
  }
  if (output?.isAggregate) {
    problems.push(
      `System output is aggregate device ${output.name}; select physical speakers or headphones because FaceTime Voice Processing rejects this input/output pair.`,
    );
  } else if (!output?.name || /BlackHole|OpenClaw-(?:Feed|Mic)/iu.test(output.name)) {
    problems.push(
      `System output is ${output?.name || "unknown"}; select physical speakers or headphones and reserve virtual devices for the bridge output.`,
    );
  }
  return problems;
}

export function buildSoxOutputArguments(outputDevice) {
  return [
    "-q",
    "--buffer",
    "480",
    "-t",
    "raw",
    "-r",
    "24000",
    "-c",
    "1",
    "-e",
    "signed-integer",
    "-b",
    "16",
    "-L",
    "-",
    "-t",
    "coreaudio",
    outputDevice,
  ];
}

export function buildSessionUpdate({ instructions, voice }) {
  return {
    type: "session.update",
    session: {
      type: "realtime",
      instructions,
      output_modalities: ["audio"],
      audio: {
        input: {
          format: { type: "audio/pcm", rate: 24000 },
          noise_reduction: null,
          transcription: { model: "gpt-4o-mini-transcribe" },
          turn_detection: {
            type: "server_vad",
            threshold: 0.5,
            prefix_padding_ms: 300,
            silence_duration_ms: 500,
            create_response: true,
            interrupt_response: true,
          },
        },
        output: {
          format: { type: "audio/pcm", rate: 24000 },
          voice,
        },
      },
    },
  };
}

export function websocketQueueWouldOverflow(bufferedAmount, payloadBytes) {
  return bufferedAmount + payloadBytes > MAX_WEBSOCKET_BUFFERED_BYTES;
}

export function playbackQueueWouldOverflow(bufferedAmount, payloadBytes) {
  return bufferedAmount + payloadBytes > MAX_PLAYBACK_BUFFERED_BYTES;
}

export function readAudioDelta(event) {
  if (
    event?.type !== "conversation.output_audio.delta" &&
    event?.type !== "response.audio.delta" &&
    event?.type !== "response.output_audio.delta"
  ) {
    return undefined;
  }
  return typeof event.delta === "string"
    ? event.delta
    : typeof event.data === "string"
      ? event.data
      : undefined;
}

export function schedulePlaybackSegment({
  audioDurationMs,
  generatedAudioMs,
  nowMs,
  playbackUntilMs,
}) {
  // A continuous stream is already buffered. After an underrun, budget for the
  // SoX/CoreAudio path before treating newly written samples as caller-audible.
  const wallStartMs = nowMs < playbackUntilMs ? playbackUntilMs : nowMs + OUTPUT_LATENCY_BUDGET_MS;
  return {
    audioEndMs: generatedAudioMs + audioDurationMs,
    audioStartMs: generatedAudioMs,
    wallEndMs: wallStartMs + audioDurationMs,
    wallStartMs,
  };
}

export function calculatePlayedAudioMs({ nowMs, segments }) {
  let playedAudioMs = 0;
  for (const segment of segments) {
    if (nowMs <= segment.wallStartMs) {
      break;
    }
    const playedInSegmentMs = Math.min(
      segment.audioEndMs - segment.audioStartMs,
      nowMs - segment.wallStartMs,
    );
    playedAudioMs = segment.audioStartMs + playedInSegmentMs;
  }
  return Math.max(0, Math.floor(playedAudioMs));
}

export function buildTruncateEvent({ audioEndMs, contentIndex, itemId }) {
  return {
    type: "conversation.item.truncate",
    item_id: itemId,
    content_index: contentIndex,
    audio_end_ms: audioEndMs,
  };
}

function commandExists(command) {
  return (
    spawnSync("/usr/bin/which", [command], {
      encoding: "utf8",
      env: sanitizedChildEnv(),
    }).status === 0
  );
}

export function sanitizedChildEnv(env = process.env) {
  const sanitized = { ...env };
  delete sanitized.OPENAI_API_KEY;
  return sanitized;
}

function captureBinaryIsExecutable(captureBinary) {
  try {
    accessSync(captureBinary, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function readBridgeOutputDevices() {
  try {
    const output = execFileSync("/usr/sbin/system_profiler", ["SPAudioDataType"], {
      encoding: "utf8",
      env: sanitizedChildEnv(),
      stdio: ["ignore", "pipe", "ignore"],
    });
    return parseBridgeOutputDevices(output);
  } catch {
    return [];
  }
}

function readDefaultAudioDevices(captureBinary) {
  const result = spawnSync(captureBinary, ["--default-devices"], {
    encoding: "utf8",
    env: sanitizedChildEnv(),
  });
  if (result.status !== 0) {
    throw new Error(
      (result.stderr || result.stdout || `audio device query exited ${result.status}`).trim(),
    );
  }
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(
      `Could not parse the default Core Audio devices: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function isCallAppRunning() {
  return ["FaceTime", "Phone"].some(
    (app) =>
      spawnSync("/usr/bin/pgrep", ["-x", app], {
        env: sanitizedChildEnv(),
        stdio: "ignore",
      }).status === 0,
  );
}

function printDoctorCheck(ok, label, detail) {
  process.stdout.write(`${ok ? "✓" : "✗"} ${label}${detail ? `: ${detail}` : ""}\n`);
}

export function runDoctor(options) {
  const devices = readBridgeOutputDevices();
  let selectedDevice;
  let outputDeviceError;
  try {
    selectedDevice = resolveOutputDevice(options.outputDevice, devices);
  } catch (error) {
    outputDeviceError = error instanceof Error ? error.message : String(error);
  }
  const hasSox = commandExists("sox");
  const callAppRunning = isCallAppRunning();
  let audioRoute;
  let audioRouteError;
  if (captureBinaryIsExecutable(options.captureBinary)) {
    try {
      audioRoute = readDefaultAudioDevices(options.captureBinary);
    } catch (error) {
      audioRouteError = error instanceof Error ? error.message : String(error);
    }
  }
  const usesPairedDriver = selectedDevice === OPENCLAW_FEED_DEVICE;
  const inputReady = Boolean(audioRoute) && audioRoute.input?.name === selectedDevice;
  const hasPhysicalOutput =
    Boolean(audioRoute?.output?.name) &&
    !audioRoute.output.isAggregate &&
    !/BlackHole|OpenClaw-(?:Feed|Mic)/iu.test(audioRoute.output.name);
  const checks = [
    [process.platform === "darwin", "macOS", process.platform],
    [captureBinaryIsExecutable(options.captureBinary), "capture helper", options.captureBinary],
    [hasSox, "SoX", hasSox ? "installed" : "run brew install sox"],
    [Boolean(selectedDevice), "bridge output", selectedDevice || outputDeviceError],
    [
      callAppRunning,
      "FaceTime or Phone",
      callAppRunning ? "running" : "open the app that owns the call",
    ],
    ...(usesPairedDriver
      ? []
      : [
          [inputReady, "system input", audioRoute?.input?.name || audioRouteError || "unknown"],
          [
            hasPhysicalOutput,
            "physical call output",
            audioRoute?.output?.name || audioRouteError || "unknown",
          ],
        ]),
    [
      Boolean(process.env.OPENAI_API_KEY),
      "OPENAI_API_KEY",
      process.env.OPENAI_API_KEY ? "set" : "missing",
    ],
  ];

  if (captureBinaryIsExecutable(options.captureBinary)) {
    const captureCheck = spawnSync(options.captureBinary, ["--check"], {
      encoding: "utf8",
      env: sanitizedChildEnv(),
    });
    checks.push([
      captureCheck.status === 0,
      "FaceTime app-audio capture",
      (captureCheck.stderr || captureCheck.stdout || `exit ${captureCheck.status}`).trim(),
    ]);
  }

  for (const [ok, label, detail] of checks) {
    printDoctorCheck(ok, label, detail);
  }
  if (usesPairedDriver) {
    process.stdout.write(
      "! manual FaceTime/Phone route: select OpenClaw-Mic as microphone and a physical device as output; the doctor cannot inspect app-specific overrides.\n",
    );
  }
  process.stdout.write(
    usesPairedDriver
      ? "\nSet FaceTime or Phone microphone to OpenClaw-Mic and output to physical speakers or headphones. The bridge writes model speech to OpenClaw-Feed.\n"
      : "\nSet FaceTime or Phone to Use System Setting for both microphone and output. Use BlackHole only for the bridge and system input; keep system output on physical speakers or headphones.\n",
  );
  return checks.every(([ok]) => ok) ? 0 : 1;
}

export async function runRealtimePreflight(options) {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is not set");
  }

  const url = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(options.model)}`;
  await new Promise((resolve, reject) => {
    const socket = new WebSocket(url, {
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      maxPayload: 16 * 1024 * 1024,
    });
    let settled = false;
    const finish = (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      if (error) {
        reject(error);
        return;
      }
      resolve();
    };
    const timeout = setTimeout(() => {
      socket.close(1000, "Preflight timed out");
      finish(new Error("OpenAI Realtime preflight timed out after 15 seconds"));
    }, 15_000);

    socket.once("open", () => socket.send(JSON.stringify(buildSessionUpdate(options))));
    socket.on("message", (raw) => {
      let event;
      try {
        event = JSON.parse(String(raw));
      } catch (error) {
        socket.close(1002, "Invalid event");
        finish(
          new Error(
            `Invalid Realtime event: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
        return;
      }
      if (event.type === "session.updated") {
        socket.close(1000, "Preflight complete");
        finish();
        return;
      }
      if (event.type === "error") {
        const detail = event.error?.message || event.error?.code || "unknown error";
        socket.close(1000, "Preflight failed");
        finish(new Error(`OpenAI Realtime error: ${detail}`));
      }
    });
    socket.once("error", (error) => finish(error));
    socket.once("close", (code, reason) => {
      if (code !== 1000) {
        finish(new Error(`OpenAI Realtime closed (${code}: ${String(reason) || "no reason"})`));
      }
    });
  });
  process.stderr.write(`OpenAI Realtime preflight passed: ${options.model}/${options.voice}.\n`);
}

function terminate(child) {
  if (child && child.exitCode === null && !child.killed) {
    child.kill("SIGTERM");
  }
}

function startOutputProcess(outputDevice, onFailure) {
  const child = spawn("sox", buildSoxOutputArguments(outputDevice), {
    env: sanitizedChildEnv(),
    stdio: ["pipe", "ignore", "pipe"],
  });
  child.stderr.on("data", (chunk) => {
    const message = String(chunk).trim();
    if (message) {
      process.stderr.write(`[sox] ${message}\n`);
    }
  });
  child.on("error", onFailure);
  child.stdin.on("error", onFailure);
  return child;
}

export async function runBridge(options) {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is not set");
  }
  if (!captureBinaryIsExecutable(options.captureBinary)) {
    throw new Error(
      `Capture helper not found at ${options.captureBinary}. Run pnpm build:capture first.`,
    );
  }
  if (!commandExists("sox")) {
    throw new Error("SoX is not installed. Run brew install sox.");
  }
  const outputDevice = resolveOutputDevice(options.outputDevice, readBridgeOutputDevices());
  const audioRoute = readDefaultAudioDevices(options.captureBinary);
  const routeProblems = findAudioRouteProblems({ bridgeOutputDevice: outputDevice, ...audioRoute });
  if (routeProblems.length > 0) {
    throw new Error(`Invalid FaceTime audio route:\n- ${routeProblems.join("\n- ")}`);
  }
  if (outputDevice === OPENCLAW_FEED_DEVICE) {
    process.stderr.write(
      "Manual route check: FaceTime/Phone must use OpenClaw-Mic as microphone and a physical output device.\n",
    );
  }

  const url = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(options.model)}`;
  const socket = new WebSocket(url, {
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    maxPayload: 16 * 1024 * 1024,
  });
  let captureProcess;
  let outputProcess;
  let closing = false;
  let playbackItems = [];
  let playbackUntilMs = 0;

  const fail = (error) => {
    if (!closing) {
      process.stderr.write(
        `FaceTime bridge failed: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      void close(1);
    }
  };
  const spawnOutput = () => {
    const child = startOutputProcess(outputDevice, (error) => {
      if (!closing && child === outputProcess) {
        fail(error);
      }
    });
    outputProcess = child;
    child.on("exit", (code, signal) => {
      if (!closing && child === outputProcess) {
        fail(new Error(`SoX output exited (${code ?? signal ?? "unknown"})`));
      }
    });
  };
  const restartOutput = () => {
    const previous = outputProcess;
    spawnOutput();
    playbackItems = [];
    playbackUntilMs = 0;
    terminate(previous);
  };
  const close = async (exitCode = 0) => {
    if (closing) {
      return;
    }
    closing = true;
    terminate(captureProcess);
    terminate(outputProcess);
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
      socket.close(1000, "Bridge stopped");
    }
    process.exitCode = exitCode;
  };

  process.once("SIGINT", () => void close());
  process.once("SIGTERM", () => void close());

  socket.on("open", () => {
    if (closing) {
      return;
    }
    socket.send(JSON.stringify(buildSessionUpdate(options)));
  });
  socket.on("message", (raw) => {
    if (closing) {
      return;
    }
    let event;
    try {
      event = JSON.parse(String(raw));
    } catch (error) {
      fail(
        new Error(
          `Invalid Realtime event: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
      return;
    }

    if (event.type === "session.updated") {
      if (captureProcess) {
        return;
      }
      spawnOutput();
      captureProcess = spawn(options.captureBinary, [], {
        env: sanitizedChildEnv(),
        stdio: ["ignore", "pipe", "pipe"],
      });
      captureProcess.stderr.on("data", (chunk) => process.stderr.write(String(chunk)));
      captureProcess.on("error", fail);
      captureProcess.on("exit", (code, signal) => {
        if (!closing) {
          fail(new Error(`capture helper exited (${code ?? signal ?? "unknown"})`));
        }
      });
      captureProcess.stdout.on("data", (chunk) => {
        if (socket.readyState === WebSocket.OPEN && chunk.length > 0) {
          const payload = JSON.stringify({
            type: "input_audio_buffer.append",
            audio: Buffer.from(chunk).toString("base64"),
          });
          if (websocketQueueWouldOverflow(socket.bufferedAmount, Buffer.byteLength(payload))) {
            fail(new Error("OpenAI Realtime input stalled; caller-audio queue exceeded 512 KiB"));
            return;
          }
          socket.send(payload);
        }
      });
      process.stderr.write(
        `FaceTime bridge ready: ${options.model}/${options.voice} -> ${outputDevice}. Press Ctrl-C to stop.\n`,
      );
      return;
    }

    const delta = readAudioDelta(event);
    if (delta && outputProcess?.stdin.writable) {
      const audio = Buffer.from(delta, "base64");
      if (playbackQueueWouldOverflow(outputProcess.stdin.writableLength, audio.byteLength)) {
        fail(new Error("Bridge playback stalled; model-audio queue exceeded 2 MiB"));
        return;
      }
      const contentIndex = Number.isInteger(event.content_index) ? event.content_index : 0;
      let playbackItem;
      if (event.item_id) {
        playbackItem = playbackItems.find(
          (item) => item.itemId === event.item_id && item.contentIndex === contentIndex,
        );
        if (!playbackItem) {
          playbackItem = {
            contentIndex,
            generatedAudioMs: 0,
            itemId: event.item_id,
            segments: [],
          };
          playbackItems.push(playbackItem);
        }
      }
      const segment = schedulePlaybackSegment({
        audioDurationMs: audio.byteLength / 48,
        generatedAudioMs: playbackItem?.generatedAudioMs ?? 0,
        nowMs: Date.now(),
        playbackUntilMs,
      });
      playbackUntilMs = segment.wallEndMs;
      if (playbackItem) {
        playbackItem.generatedAudioMs = segment.audioEndMs;
        const previousSegment = playbackItem.segments.at(-1);
        if (
          previousSegment?.wallEndMs === segment.wallStartMs &&
          previousSegment.audioEndMs === segment.audioStartMs
        ) {
          previousSegment.audioEndMs = segment.audioEndMs;
          previousSegment.wallEndMs = segment.wallEndMs;
        } else {
          playbackItem.segments.push(segment);
        }
      } else {
        // Compatibility events without an item id cannot be reconciled with
        // conversation history, but their local queued audio is still cleared.
      }
      outputProcess.stdin.write(audio);
      return;
    }
    if (event.type === "input_audio_buffer.speech_started" && Date.now() < playbackUntilMs) {
      const nowMs = Date.now();
      for (const item of playbackItems) {
        const audioEndMs = calculatePlayedAudioMs({ nowMs, segments: item.segments });
        if (audioEndMs < item.generatedAudioMs) {
          socket.send(
            JSON.stringify(
              buildTruncateEvent({
                audioEndMs,
                contentIndex: item.contentIndex,
                itemId: item.itemId,
              }),
            ),
          );
        }
      }
      restartOutput();
      return;
    }
    if (
      (event.type === "conversation.item.input_audio_transcription.completed" ||
        event.type === "response.output_audio_transcript.done") &&
      (event.transcript || event.text)
    ) {
      const role = event.type.startsWith("response.") ? "assistant" : "caller";
      process.stderr.write(`[${role}] ${event.transcript || event.text}\n`);
      return;
    }
    if (event.type === "error") {
      const detail = event.error?.message || event.error?.code || JSON.stringify(event.error);
      fail(new Error(`OpenAI Realtime error: ${detail}`));
    }
  });
  socket.on("error", fail);
  socket.on("close", (code, reason) => {
    if (!closing) {
      fail(new Error(`OpenAI Realtime closed (${code}: ${String(reason) || "no reason"})`));
    }
  });
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.doctor) {
    process.exitCode = runDoctor(options);
    return;
  }
  if (options.preflight) {
    await runRealtimePreflight(options);
    return;
  }
  await runBridge(options);
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
