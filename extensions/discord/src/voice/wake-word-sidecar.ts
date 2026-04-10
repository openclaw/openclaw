/**
 * Manages the openWakeWord Python sidecar process.
 *
 * Communication protocol:
 *   stdin  (Node → Python): binary framing — [type: 1B] [length: 4B BE] [payload]
 *   stdout (Python → Node): newline-delimited JSON detection events
 *
 * The sidecar is a stateless audio-in / detection-out pipe. User routing
 * (which Discord user's audio produced a detection) is handled Node-side
 * by WakeWordSession, not in the sidecar.
 */

import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import { formatErrorMessage } from "openclaw/plugin-sdk/infra-runtime";
import {
  SIDECAR_MSG_AUDIO,
  SIDECAR_MSG_CONFIGURE,
  SIDECAR_HEADER_SIZE,
  type SidecarConfigurePayload,
  type SidecarEvent,
  type SidecarDetectionEvent,
  WAKE_WORD_DEFAULTS,
} from "./wake-word-types.js";

const logger = createSubsystemLogger("discord/voice/wake-sidecar");

/** How long a healthy sidecar must stay alive before the retry counter resets. */
const HEALTH_RESET_MS = 60_000;

/** Maximum retry attempts before giving up. */
const MAX_RETRIES = 3;

/** Base delay for exponential backoff (ms). */
const BACKOFF_BASE_MS = 1_000;

/**
 * Embedded Python sidecar script. Written to a temp file on first spawn
 * so the script location is independent of the JS build output directory.
 */
// prettier-ignore
const SIDECAR_PYTHON_SCRIPT = [
  '#!/usr/bin/env python3',
  '"""openWakeWord sidecar — binary stdin, JSON stdout."""',
  'from __future__ import annotations',
  'import json, struct, sys, time',
  'from typing import Any',
  'MSG_AUDIO, MSG_CONFIGURE, HEADER_SIZE = 0x01, 0x02, 5',
  'DEFAULT_CONFIDENCE = 0.7',
  'def emit(event: dict[str, Any]):',
  '    sys.stdout.write(json.dumps(event) + "\\n"); sys.stdout.flush()',
  'def read_exactly(stream, n):',
  '    buf = b""',
  '    while len(buf) < n:',
  '        chunk = stream.read(n - len(buf))',
  '        if not chunk: raise EOFError("stdin closed")',
  '        buf += chunk',
  '    return buf',
  'def main():',
  '    try:',
  '        from openwakeword.model import Model as OWWModel',
  '    except ImportError:',
  '        emit({"type": "error", "message": "openwakeword not installed (pip install openwakeword)"})',
  '        sys.exit(1)',
  '    model, confidence_threshold, configured = None, DEFAULT_CONFIDENCE, False',
  '    stdin = sys.stdin.buffer',
  '    emit({"type": "ready"})',
  '    while True:',
  '        try: header = read_exactly(stdin, HEADER_SIZE)',
  '        except EOFError: break',
  '        msg_type, length = header[0], struct.unpack(">I", header[1:5])[0]',
  '        payload = read_exactly(stdin, length) if length > 0 else b""',
  '        if msg_type == MSG_CONFIGURE:',
  '            try: cfg = json.loads(payload.decode("utf-8"))',
  '            except Exception as exc:',
  '                emit({"type": "error", "message": f"bad config: {exc}"}); continue',
  '            confidence_threshold = cfg.get("confidence", DEFAULT_CONFIDENCE)',
  '            model_path = cfg.get("modelPath")',
  '            triggers = cfg.get("triggers", [])',
  '            try:',
  '                if model_path:',
  '                    model = OWWModel(wakeword_models=[model_path], inference_framework="onnx")',
  '                elif triggers:',
  '                    names = [t.lower().replace(" ", "_") for t in triggers]',
  '                    try: model = OWWModel(wakeword_models=names, inference_framework="onnx")',
  '                    except Exception:',
  '                        emit({"type": "error", "message": f"models {names} not found; loading all"})',
  '                        model = OWWModel(inference_framework="onnx")',
  '                else:',
  '                    model = OWWModel(inference_framework="onnx")',
  '                configured = True',
  '                emit({"type": "ready"})',
  '            except Exception as exc:',
  '                emit({"type": "error", "message": f"model load failed: {exc}"}); model = None',
  '        elif msg_type == MSG_AUDIO:',
  '            if not configured or model is None: continue',
  '            import numpy as np',
  '            audio = np.frombuffer(payload, dtype=np.int16)',
  '            if audio.size == 0: continue',
  '            prediction = model.predict(audio)',
  '            for wake_word, score in prediction.items():',
  '                if score >= confidence_threshold:',
  '                    emit({"type": "detection", "trigger": wake_word,',
  '                          "confidence": round(float(score), 4),',
  '                          "timestamp": int(time.time() * 1000)})',
  '                    model.reset(); break',
  '        else:',
  '            emit({"type": "error", "message": f"unknown msg type: {msg_type}"})',
  'if __name__ == "__main__": main()',
].join("\n");

let cachedScriptPath: string | null = null;

function ensureSidecarScript(): string {
  if (cachedScriptPath && fs.existsSync(cachedScriptPath)) {
    return cachedScriptPath;
  }
  const tmpDir = path.join(os.tmpdir(), "openclaw-wake-word");
  fs.mkdirSync(tmpDir, { recursive: true });
  const scriptPath = path.join(tmpDir, "sidecar.py");
  fs.writeFileSync(scriptPath, SIDECAR_PYTHON_SCRIPT, "utf-8");
  cachedScriptPath = scriptPath;
  return scriptPath;
}

export type WakeWordSidecarOptions = {
  pythonPath?: string;
  triggers: string[];
  confidence?: number;
  modelPath?: string;
  onDetection: (event: SidecarDetectionEvent) => void;
};

export class WakeWordSidecar {
  private process: ChildProcess | null = null;
  private retryCount = 0;
  private startedAt = 0;
  private destroyed = false;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly pythonPath: string;
  private readonly scriptPath: string;
  private readonly triggers: string[];
  private readonly confidence: number;
  private readonly modelPath?: string;
  private readonly onDetection: (event: SidecarDetectionEvent) => void;

  constructor(options: WakeWordSidecarOptions) {
    this.pythonPath = options.pythonPath ?? WAKE_WORD_DEFAULTS.pythonPath;
    this.scriptPath = ensureSidecarScript();
    this.triggers = options.triggers;
    this.confidence = options.confidence ?? WAKE_WORD_DEFAULTS.confidence;
    this.modelPath = options.modelPath;
    this.onDetection = options.onDetection;
  }

  /**
   * Spawn the Python sidecar and send the initial configuration.
   */
  async start(): Promise<void> {
    if (this.destroyed) {
      return;
    }
    this.spawnProcess();
  }

  /**
   * Kill the sidecar and prevent any further restarts.
   */
  destroy(): void {
    this.destroyed = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    this.killProcess();
  }

  /**
   * Send a chunk of 16 kHz mono PCM audio to the sidecar.
   */
  sendAudio(pcm: Buffer): void {
    this.sendBinaryFrame(SIDECAR_MSG_AUDIO, pcm);
  }

  /**
   * Returns true if the sidecar process is alive.
   */
  isAlive(): boolean {
    return this.process !== null && !this.process.killed;
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  private spawnProcess(): void {
    this.killProcess();

    logger.info(`spawning openWakeWord sidecar: ${this.pythonPath} ${this.scriptPath}`);
    this.startedAt = Date.now();

    const proc = spawn(this.pythonPath, [this.scriptPath], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });
    this.process = proc;

    // Parse JSON lines from stdout.
    const rl = createInterface({ input: proc.stdout! });
    rl.on("line", (line) => {
      this.handleStdoutLine(line);
    });

    // Log stderr for diagnostics.
    proc.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (text) {
        logger.warn(`sidecar stderr: ${text}`);
      }
    });

    proc.on("exit", (code, signal) => {
      logger.warn(`sidecar exited: code=${code} signal=${signal}`);
      this.process = null;
      this.scheduleRestart();
    });

    proc.on("error", (err) => {
      logger.warn(`sidecar error: ${formatErrorMessage(err)}`);
      this.process = null;
      this.scheduleRestart();
    });

    // Send initial configuration.
    const configPayload: SidecarConfigurePayload = {
      triggers: this.triggers,
      confidence: this.confidence,
      modelPath: this.modelPath,
    };
    this.sendBinaryFrame(SIDECAR_MSG_CONFIGURE, Buffer.from(JSON.stringify(configPayload)));
  }

  private killProcess(): void {
    if (this.process) {
      try {
        this.process.kill("SIGTERM");
      } catch {
        // Process may have already exited.
      }
      this.process = null;
    }
  }

  private scheduleRestart(): void {
    if (this.destroyed) {
      return;
    }

    // If the sidecar stayed alive long enough, reset the retry counter.
    if (Date.now() - this.startedAt >= HEALTH_RESET_MS) {
      this.retryCount = 0;
    }

    this.retryCount += 1;
    if (this.retryCount > MAX_RETRIES) {
      logger.warn(
        `sidecar exceeded ${MAX_RETRIES} restart attempts; wake word detection disabled until manual restart`,
      );
      return;
    }

    const delayMs = BACKOFF_BASE_MS * 2 ** (this.retryCount - 1);
    logger.info(`sidecar restart ${this.retryCount}/${MAX_RETRIES} in ${delayMs}ms`);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.spawnProcess();
    }, delayMs);
    this.restartTimer.unref();
  }

  /**
   * Send a binary-framed message on stdin.
   *
   * Wire format: [type: 1 byte] [length: 4 bytes big-endian] [payload]
   */
  private sendBinaryFrame(type: number, payload: Buffer): void {
    if (!this.process?.stdin?.writable) {
      return;
    }
    const header = Buffer.allocUnsafe(SIDECAR_HEADER_SIZE);
    header[0] = type;
    header.writeUInt32BE(payload.length, 1);
    this.process.stdin.write(header);
    this.process.stdin.write(payload);
  }

  private handleStdoutLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }
    let event: SidecarEvent;
    try {
      event = JSON.parse(trimmed) as SidecarEvent;
    } catch {
      logger.warn(`sidecar: unparseable stdout line: ${trimmed}`);
      return;
    }

    switch (event.type) {
      case "ready":
        logger.info("sidecar ready");
        break;
      case "detection":
        logger.info(
          `wake word detected: trigger="${event.trigger}" confidence=${event.confidence.toFixed(2)}`,
        );
        this.onDetection(event);
        break;
      case "error":
        logger.warn(`sidecar error: ${event.message}`);
        break;
      default:
        logger.warn(`sidecar: unknown event type: ${JSON.stringify(event)}`);
    }
  }
}
