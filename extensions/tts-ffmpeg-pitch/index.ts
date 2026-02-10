import type { PluginApi } from "openclaw/plugin-sdk";
import { fileURLToPath } from "node:url";

export default function register(api: PluginApi) {
  api.logger.info("TTS FFmpeg Pitch plugin loaded");

  // Optional: register CLI command for testing
  api.registerCli(
    ({ program }) => {
      program
        .command("tts-pitch <input> <output>")
        .description("Apply FFmpeg pitch modulation to an audio file")
        .option("--pitch <n>", "pitch multiplier (1.0 = normal, <1.0 = deeper)", "1.0")
        .option("--speed <n>", "speed multiplier (1.0 = normal)", "1.0")
        .action(async (input, output, opts) => {
          const { spawn } = await import("node:child_process");
          const { existsSync } = await import("node:fs");
          const path = await import("node:path");

          if (!existsSync(input)) {
            console.error(`Input file not found: ${input}`);
            process.exit(1);
          }

          const pitch = Number.parseFloat(opts.pitch);
          const speed = Number.parseFloat(opts.speed);

          if (!Number.isFinite(pitch) || pitch < 0.5 || pitch > 2.0) {
            console.error("Pitch must be between 0.5 and 2.0");
            process.exit(1);
          }

          if (!Number.isFinite(speed) || speed < 0.5 || speed > 2.0) {
            console.error("Speed must be between 0.5 and 2.0");
            process.exit(1);
          }

          const pluginDir = path.dirname(fileURLToPath(import.meta.url));
          const scriptPath = path.join(pluginDir, "bin", "process-audio.sh");

          const env = {
            ...process.env,
            OPENCLAW_TTS_INPUT: input,
            OPENCLAW_TTS_OUTPUT: output,
            FFMPEG_PITCH: String(pitch),
            FFMPEG_SPEED: String(speed),
          };

          const proc = spawn(scriptPath, [], { env, stdio: "inherit" });

          proc.on("exit", (code) => {
            process.exit(code ?? 0);
          });
        });
    },
    { commands: ["tts-pitch"] },
  );
}
