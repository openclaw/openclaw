/**
 * CLI subcommand registration for the stimm-voice plugin.
 *
 * Exposes `openclaw voice [start|stop|status|setup]` commands.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import qrcode from "qrcode-terminal";
import type { StimmVoiceConfig } from "./config.js";

type VoiceSession = {
  roomName: string;
  clientToken: string;
  createdAt: number;
  originChannel: string;
  supervisor: { connected: boolean };
  shareUrl?: string;
  claimToken?: string;
};

type RoomManager = {
  createSession: (opts: { roomName?: string; originChannel: string }) => Promise<VoiceSession>;
  endSession: (room: string) => Promise<boolean>;
  listSessions: () => VoiceSession[];
};

type SupervisorObsEvent = {
  component: string;
  event: string;
  inference_seq?: number;
  latency_ms?: number;
  structured_json?: boolean;
  action?: string;
  reason?: string;
  text_chars?: number;
};

const supportsAnsi =
  Boolean(process.stdout?.isTTY) &&
  !Object.prototype.hasOwnProperty.call(process.env, "NO_COLOR") &&
  process.env.FORCE_COLOR !== "0";

function color(code: string, value: string): string {
  if (!supportsAnsi) return value;
  return `\u001b[${code}m${value}\u001b[0m`;
}

function heading(value: string): string {
  return color("1;36", value);
}

function key(value: string): string {
  return color("2", value);
}

function ok(value: string): string {
  return color("32", value);
}

function warn(value: string): string {
  return color("33", value);
}

function info(value: string): string {
  return color("36", value);
}

function renderQrAscii(data: string): Promise<string> {
  return new Promise((resolve) => {
    qrcode.generate(data, { small: true }, (output: string) => {
      resolve(output.trimEnd());
    });
  });
}

function parseObsEventFromLine(line: string): SupervisorObsEvent | null {
  const marker = "OBS_JSON ";
  const markerIndex = line.indexOf(marker);
  if (markerIndex === -1) return null;
  const payload = line.slice(markerIndex + marker.length).trim();
  try {
    const parsed = JSON.parse(payload) as SupervisorObsEvent;
    if (parsed.component !== "conversation_supervisor" || typeof parsed.event !== "string") {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function formatObsEvent(event: SupervisorObsEvent): string {
  const seq = event.inference_seq ?? "?";
  if (event.event === "inference_started") {
    return `${heading(`[SUPERVISOR #${seq}]`)} ${info("inference_started")}`;
  }
  if (event.event === "inference_completed") {
    const structured = event.structured_json ? ok("yes") : warn("no");
    const reason = event.reason && event.reason.trim().length > 0 ? event.reason : "n/a";
    return [
      `${heading(`[SUPERVISOR #${seq}]`)} ${info("inference_completed")}`,
      `  ${key("latency_ms")}: ${event.latency_ms ?? "?"}`,
      `  ${key("structured_json")}: ${structured}`,
      `  ${key("action")}: ${event.action ?? "n/a"}`,
      `  ${key("reason")}: ${reason}`,
    ].join("\n");
  }
  if (event.event === "trigger_sent") {
    return [
      `${heading(`[SUPERVISOR #${seq}]`)} ${ok("trigger_sent")}`,
      `  ${key("text_chars")}: ${event.text_chars ?? "?"}`,
    ].join("\n");
  }
  if (event.event === "no_action") {
    return `${heading(`[SUPERVISOR #${seq}]`)} ${warn("no_action")}`;
  }
  return `${heading(`[SUPERVISOR #${seq}]`)} ${event.event}`;
}

function takeLast<T>(items: T[], limit: number): T[] {
  return items.slice(Math.max(0, items.length - limit));
}

function resolveLatestGatewayLogFile(): string | null {
  const dir = "/tmp/openclaw";
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir)
    .filter((name) => /^openclaw-\d{4}-\d{2}-\d{2}\.log$/.test(name))
    .sort();
  if (files.length === 0) return null;
  return `${dir}/${files[files.length - 1]}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractGatewayMessage(line: string): string {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return line;
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    const message = parsed["1"];
    if (typeof message === "string") return message;
  } catch {
    /* ignore JSON parse errors */
  }
  return line;
}

function decodeHeavyEscapes(line: string): string {
  const backslashCount = (line.match(/\\/g) ?? []).length;
  if (backslashCount < 8) return line;
  try {
    return JSON.parse(`"${line.replace(/"/g, '\\"')}"`) as string;
  } catch {
    return line.replace(/\\\\/g, "\\");
  }
}

function dedupeConsecutive(lines: string[]): string[] {
  const result: string[] = [];
  for (const line of lines) {
    if (result.length === 0 || result[result.length - 1] !== line) {
      result.push(line);
    }
  }
  return result;
}

function shouldDisplayObsEvent(event: SupervisorObsEvent, includeStarted: boolean): boolean {
  if (includeStarted) return true;
  return event.event !== "inference_started";
}

interface VoiceCliDeps {
  program: {
    command: (name: string) => {
      description: (d: string) => any;
      option: (flags: string, desc: string, defaultValue?: string) => any;
      action: (fn: (...args: any[]) => Promise<void>) => any;
    };
  };
  config: StimmVoiceConfig;
  ensureRuntime: () => Promise<{ roomManager: RoomManager }>;
  logger: { info: (message: string) => void; error: (message: string) => void };
  /** Extension root directory (for venv detection in setup). */
  extensionDir?: string;
}

export function registerStimmVoiceCli(deps: VoiceCliDeps): void {
  const { program, config, ensureRuntime, logger } = deps;

  const voice = program,
    cmd = voice.command("voice");
  cmd
    .description("Stimm voice session management")
    .option("--channel <channel>", "Origin channel for routing", "web");

  const start = program.command("voice:start");
  start
    .description("Start a new voice session")
    .option("--channel <channel>", "Origin channel", "web")
    .option("--room <name>", "Custom room name")
    .option("--wait", "Keep process alive and end the session on exit (Ctrl+C / SIGTERM)")
    .action(async (opts: { channel: string; room?: string; wait?: boolean }) => {
      if (!config.enabled) {
        logger.error("[stimm-voice] Plugin is disabled. Set stimm-voice.enabled=true in config.");
        return;
      }
      const rt = await ensureRuntime();
      const session = await rt.roomManager.createSession({
        roomName: opts.room,
        originChannel: opts.channel,
      });
      logger.info(`Voice session started!`);
      logger.info(`  Room:  ${session.roomName}`);
      if (session.shareUrl) {
        logger.info(`  Share URL: ${session.shareUrl}`);
        if (session.claimToken) {
          logger.info(`  Claim token: ${session.claimToken}`);
        }
        const qr = await renderQrAscii(session.shareUrl);
        logger.info("  Scan this QR code from your phone:");
        logger.info("");
        for (const line of qr.split("\n")) {
          logger.info(`  ${line}`);
        }
        logger.info("");
        logger.info(`  Open the Share URL on your phone to connect.`);
      } else {
        logger.info(`  Token: ${session.clientToken}`);
        logger.info(`  Use this token to connect from a LiveKit client.`);
      }

      if (!opts.wait && !session.shareUrl) {
        // No tunnel running in this process — LiveKit SDK keeps open
        // HTTP/WebSocket handles so we exit explicitly to avoid hanging.
        process.exit(0);
      }

      if (opts.wait || session.shareUrl) {
        if (session.shareUrl) {
          logger.info(`  Press Ctrl+C (or send SIGTERM) to end the session and close the tunnel.`);
        } else {
          logger.info(`  Press Ctrl+C (or send SIGTERM) to end the session and exit.`);
        }
        let exiting = false;
        let resolveKeepAlive!: () => void;
        const keepAlive = new Promise<void>((res) => {
          resolveKeepAlive = res;
        });
        const cleanup = async () => {
          if (exiting) return;
          exiting = true;
          logger.info(`\n[stimm-voice] Ending session "${session.roomName}"…`);
          try {
            const rt2 = await ensureRuntime();
            const ok = await rt2.roomManager.endSession(session.roomName);
            if (ok) {
              logger.info(`[stimm-voice] Session ended.`);
            } else {
              logger.info(`[stimm-voice] Session already gone (remote teardown?).`);
            }
          } catch (err) {
            logger.error(
              `[stimm-voice] Failed to end session: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
          resolveKeepAlive();
          process.exit(0);
        };
        process.once("SIGINT", () => void cleanup());
        process.once("SIGTERM", () => void cleanup());
        await keepAlive;
      }
    });

  const stop = program.command("voice:stop");
  stop
    .description("Stop a voice session")
    .option("--room <name>", "Room name to stop")
    .action(async (opts: { room: string }) => {
      if (!opts.room) {
        logger.error("--room is required");
        return;
      }
      const rt = await ensureRuntime();
      const ok = await rt.roomManager.endSession(opts.room);
      if (ok) {
        logger.info(`Voice session stopped: ${opts.room}`);
      } else {
        logger.error(`No active session found: ${opts.room}`);
      }
    });

  const status = program.command("voice:status");
  status.description("List active voice sessions").action(async () => {
    const rt = await ensureRuntime();
    const sessions = rt.roomManager.listSessions();
    if (sessions.length === 0) {
      logger.info("No active voice sessions.");
      return;
    }
    for (const s of sessions) {
      const age = Math.round((Date.now() - s.createdAt) / 1000);
      logger.info(
        `  ${s.roomName}  channel=${s.originChannel}  age=${age}s  supervisor=${s.supervisor.connected ? "connected" : "disconnected"}`,
      );
    }
  });

  const setup = program.command("voice:setup");
  setup
    .description("Interactive setup wizard — choose providers, models, and API keys")
    .action(async () => {
      const { runSetupWizard } = await import("./setup-wizard.js");
      await runSetupWizard({
        logger,
        extensionDir: deps.extensionDir ?? "",
      });
    });

  const doctor = program.command("voice:doctor");
  doctor.description("Check voice pipeline prerequisites").action(async () => {
    const { spawnSync } = await import("node:child_process");

    if (config.access.mode === "quick-tunnel") {
      const probe = spawnSync("cloudflared", ["--version"], { encoding: "utf8" });
      if (probe.status === 0) {
        logger.info("  ✅ cloudflared: installed");
      } else {
        logger.info(
          "  ❌ cloudflared: not installed — https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/",
        );
      }
      logger.info("  ℹ️  Access mode: quick-tunnel");
    } else {
      logger.info("  ℹ️  Access mode: none (no public tunnel)");
    }

    // Check LiveKit config.
    logger.info(`  ℹ️  LiveKit: ${config.livekit.url}`);

    // Check plugin enabled.
    if (config.enabled) {
      logger.info("  ✅ Plugin: enabled");
    } else {
      logger.info("  ❌ Plugin: disabled — set stimm-voice.enabled=true");
    }
  });

  const logs = program.command("voice:logs");
  logs
    .description("Show supervisor observability logs (OBS_JSON + gateway summary)")
    .option("--limit <n>", "Number of entries to show", "40")
    .option("--raw", "Show raw OBS_JSON lines from /tmp/stimm-agent.log")
    .option("--all-events", "Include inference_started events (default hides them)")
    .option("--watch", "Watch logs continuously (Ctrl+C to stop)")
    .option("--interval <s>", "Watch refresh interval in seconds", "2")
    .action(
      async (opts: {
        limit?: string;
        raw?: boolean;
        allEvents?: boolean;
        watch?: boolean;
        interval?: string;
      }) => {
        const limit = Math.max(1, Number.parseInt(opts.limit ?? "40", 10) || 40);
        const intervalSeconds = Math.max(1, Number.parseInt(opts.interval ?? "2", 10) || 2);
        const intervalMs = intervalSeconds * 1000;
        const stimmLogFile = "/tmp/stimm-agent.log";

        if (!existsSync(stimmLogFile)) {
          logger.error("stimm log file not found: /tmp/stimm-agent.log");
          return;
        }

        const printSnapshot = (
          onlyNew: boolean,
          previousObsCount = 0,
          previousGatewayCount = 0,
        ) => {
          const stimmLines = readFileSync(stimmLogFile, "utf8").split(/\r?\n/);
          const obsLines = stimmLines.filter((line) => line.includes("OBS_JSON "));
          const obsSlice = onlyNew ? obsLines.slice(previousObsCount) : takeLast(obsLines, limit);

          if (!onlyNew) {
            logger.info(heading(`Supervisor OBS source: ${stimmLogFile}`));
          }
          if (obsLines.length === 0) {
            if (!onlyNew) logger.info("No OBS_JSON lines found yet.");
          } else if (obsSlice.length === 0 && onlyNew) {
            // Stay silent during watch when nothing new happened.
          } else if (opts.raw) {
            for (const line of dedupeConsecutive(obsSlice).map((entry) =>
              decodeHeavyEscapes(entry),
            )) {
              logger.info(line);
            }
          } else {
            const events = obsSlice
              .map((line) => parseObsEventFromLine(line))
              .filter((event): event is SupervisorObsEvent => Boolean(event))
              .filter((event) => shouldDisplayObsEvent(event, Boolean(opts.allEvents)));
            if (events.length === 0) {
              if (!onlyNew) {
                logger.info(key("No parseable OBS_JSON events."));
              }
            } else {
              for (const event of events) {
                logger.info(formatObsEvent(event));
              }
            }
          }

          const gatewayLogFile = resolveLatestGatewayLogFile();
          if (!gatewayLogFile || !existsSync(gatewayLogFile)) {
            logger.info("Gateway log file not found under /tmp/openclaw.");
            return {
              obsCount: obsLines.length,
              gatewayCount: 0,
              gatewayPath: null as string | null,
            };
          }

          const gatewayLines = readFileSync(gatewayLogFile, "utf8")
            .split(/\r?\n/)
            .map((line) => extractGatewayMessage(line))
            .filter((line) => line.includes("[stimm-voice:supervisor]"));
          const gatewaySlice = onlyNew
            ? gatewayLines.slice(previousGatewayCount)
            : takeLast(gatewayLines, limit);

          if (!onlyNew) {
            logger.info(heading(`Gateway supervisor source: ${gatewayLogFile}`));
          }
          if (gatewayLines.length === 0) {
            if (!onlyNew) logger.info("No [stimm-voice:supervisor] lines found yet.");
          } else if (gatewaySlice.length === 0 && onlyNew) {
            // Stay silent during watch when nothing new happened.
          } else {
            for (const line of dedupeConsecutive(gatewaySlice).map((entry) =>
              decodeHeavyEscapes(entry),
            )) {
              logger.info(line);
            }
          }

          return {
            obsCount: obsLines.length,
            gatewayCount: gatewayLines.length,
            gatewayPath: gatewayLogFile,
          };
        };

        const firstSnapshot = printSnapshot(false);

        if (!opts.watch) {
          return;
        }

        logger.info(info(`Watching logs every ${intervalSeconds}s. Press Ctrl+C to stop.`));

        let running = true;
        let obsCount = firstSnapshot.obsCount;
        let gatewayCount = firstSnapshot.gatewayCount;
        let gatewayPath = firstSnapshot.gatewayPath;

        const stop = () => {
          running = false;
        };
        process.once("SIGINT", stop);
        process.once("SIGTERM", stop);

        try {
          while (running) {
            await sleep(intervalMs);
            if (!running) break;

            const latestGatewayPath = resolveLatestGatewayLogFile();
            const gatewayRotated = latestGatewayPath !== gatewayPath;
            const snapshot = printSnapshot(true, obsCount, gatewayRotated ? 0 : gatewayCount);
            obsCount = snapshot.obsCount;
            gatewayCount = snapshot.gatewayCount;
            gatewayPath = snapshot.gatewayPath;
          }
        } finally {
          process.off("SIGINT", stop);
          process.off("SIGTERM", stop);
        }
      },
    );
}
