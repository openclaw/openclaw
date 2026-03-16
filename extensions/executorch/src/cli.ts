import os from "node:os";
import path from "node:path";
import type { Command } from "commander";
import type { PluginLogger } from "openclaw/plugin-sdk/executorch";
import type { RunnerBackend } from "./native-addon.js";
import { RunnerManager } from "./runner-manager.js";
import { ensureRuntimeLibraryLoadable } from "./runtime-library.js";

export type ExecuTorchCliOptions = {
  backend: RunnerBackend;
  runtimeLibraryPath: string;
  modelPath: string;
  tokenizerPath: string;
  dataPath?: string;
  logger: PluginLogger;
};

const DEFAULT_MODEL_ROOT =
  process.env.OPENCLAW_EXECUTORCH_MODEL_ROOT?.trim() ||
  path.join(os.homedir(), ".openclaw/models/parakeet");
const DEFAULT_MODEL_DIR = path.join(DEFAULT_MODEL_ROOT, "parakeet-tdt-metal");
const PARAKEET_MODEL_REPO = "younghan-meta/Parakeet-TDT-ExecuTorch-Metal";

type SetupFileGroup = {
  label: string;
  candidates: string[];
};

const REQUIRED_MODEL_FILE_GROUPS: SetupFileGroup[] = [
  { label: "model", candidates: ["model.pte"] },
  { label: "tokenizer", candidates: ["tokenizer.model"] },
];

function createRunner(options: ExecuTorchCliOptions): RunnerManager {
  return new RunnerManager({
    backend: options.backend,
    runtimeLibraryPath: options.runtimeLibraryPath,
    modelPath: options.modelPath,
    tokenizerPath: options.tokenizerPath,
    dataPath: options.dataPath,
    logger: options.logger,
  });
}

export function registerExecuTorchCli(program: Command, options: ExecuTorchCliOptions): void {
  const et = program
    .command("executorch")
    .description("ExecuTorch on-device voice commands (Parakeet-TDT Metal)");
  const defaultModelDir = DEFAULT_MODEL_DIR;

  et.command("status")
    .description("Check Parakeet runtime and model availability")
    .action(async () => {
      const { logger, backend, runtimeLibraryPath, modelPath, tokenizerPath, dataPath } = options;

      const fs = await import("node:fs/promises");
      const checks = [
        { label: "Platform", value: `${os.platform()}/${os.arch()}`, ok: true },
        { label: "Backend", value: backend, ok: true },
        { label: "Runtime library", value: runtimeLibraryPath, ok: false },
        { label: "Model file", value: modelPath, ok: false },
        { label: "Tokenizer", value: tokenizerPath, ok: false },
      ];
      if (dataPath) {
        checks.push({ label: "Backend data file", value: dataPath, ok: false });
      }

      for (const check of checks) {
        if (check.label === "Platform" || check.label === "Backend") continue;
        try {
          await fs.access(check.value);
          check.ok = true;
        } catch {
          check.ok = false;
        }
      }

      for (const check of checks) {
        const status = check.ok ? "OK" : "MISSING";
        logger.info(`  ${status.padEnd(8)} ${check.label}: ${check.value}`);
      }

      let allOk = checks.every((c) => c.ok);
      if (allOk) {
        try {
          await ensureRuntimeLibraryLoadable(runtimeLibraryPath, logger);
        } catch (error) {
          allOk = false;
          logger.warn(
            `\nRuntime dependency check failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }

      if (!allOk) {
        logger.warn(
          "\nSome components are missing. Run 'openclaw executorch setup' to fetch model and runtime files.",
        );
      } else {
        logger.info("\nAll components available. Ready for embedded on-device transcription.");
      }
    });

  et.command("transcribe")
    .description("Transcribe an audio file using on-device ExecuTorch Parakeet-TDT")
    .argument("<file>", "Path to audio file")
    .action(async (file: string) => {
      const { logger } = options;
      const runner = createRunner(options);
      try {
        const { convertToPcmF32 } = await import("./audio-convert.js");
        const fs = await import("node:fs/promises");
        const buffer = await fs.readFile(file);
        const pcm = await convertToPcmF32(buffer, path.basename(file));

        logger.info("Loading embedded model runtime (this may take ~30s on first run)...");
        const text = await runner.transcribe(pcm);
        logger.info(`\nTranscript:\n${text}`);
      } finally {
        runner.stop();
      }
    });

  et.command("setup")
    .description("Download Parakeet-TDT Metal model/runtime files")
    .option("--backend <backend>", "Target backend (metal only)", options.backend)
    .option("--model-dir <dir>", "Target directory for model files", defaultModelDir)
    .action(async (opts: { modelDir: string; backend: string }) => {
      const { logger } = options;
      const targetDir = opts.modelDir;
      const backend = opts.backend.trim();
      if (backend !== "metal") {
        logger.error("[setup] backend must be 'metal' for Parakeet-TDT migration");
        return;
      }

      const fs = await import("node:fs/promises");
      const { execFile: execFileCb } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const execFileAsync = promisify(execFileCb);
      const runtimeDir = path.dirname(options.runtimeLibraryPath);
      const runtimeFile = path.basename(options.runtimeLibraryPath);

      logger.info(`[setup] Downloading Parakeet Metal files to ${targetDir}...`);
      logger.info(`[setup] Source: huggingface.co/${PARAKEET_MODEL_REPO}`);

      await fs.mkdir(targetDir, { recursive: true });

      const fileExists = async (filePath: string): Promise<boolean> => {
        try {
          await fs.access(filePath);
          return true;
        } catch {
          return false;
        }
      };

      const ensureGroup = async ({
        label,
        candidates,
        localDir,
        required,
        makeExecutable,
      }: {
        label: string;
        candidates: string[];
        localDir: string;
        required: boolean;
        makeExecutable?: boolean;
      }): Promise<string | null> => {
        await fs.mkdir(localDir, { recursive: true });

        for (const candidate of candidates) {
          const localPath = path.join(localDir, candidate);
          if (await fileExists(localPath)) {
            if (makeExecutable) {
              await fs.chmod(localPath, 0o755);
            }
            logger.info(`[setup] ${label}: ${candidate} (already present)`);
            return localPath;
          }
        }

        const errors: string[] = [];
        for (const candidate of candidates) {
          try {
            await execFileAsync(
              "hf",
              ["download", PARAKEET_MODEL_REPO, candidate, "--local-dir", localDir],
              { timeout: 600_000 },
            );
            const localPath = path.join(localDir, candidate);
            if (!(await fileExists(localPath))) {
              throw new Error("download reported success but file is missing");
            }
            if (makeExecutable) {
              await fs.chmod(localPath, 0o755);
            }
            logger.info(`[setup] ${label}: ${candidate}`);
            return localPath;
          } catch (error) {
            errors.push(error instanceof Error ? error.message : String(error));
          }
        }

        const details = errors.length > 0 ? ` Last error: ${errors[errors.length - 1]}` : "";
        const message =
          `${label} not found. Tried: ${candidates.join(", ")} from huggingface.co/${PARAKEET_MODEL_REPO}.` +
          details;
        if (required) {
          throw new Error(message);
        }
        logger.warn(`[setup] Optional ${message}`);
        return null;
      };

      try {
        for (const group of REQUIRED_MODEL_FILE_GROUPS) {
          await ensureGroup({
            label: group.label,
            candidates: group.candidates,
            localDir: targetDir,
            required: true,
          });
        }
        logger.info("[setup] Core model files verified.");
        logger.info(`[setup] Model directory: ${targetDir}`);

        await ensureGroup({
          label: "runtime library",
          candidates: [runtimeFile],
          localDir: runtimeDir,
          required: true,
        });
        logger.info(`[setup] Runtime library path: ${options.runtimeLibraryPath}`);

        logger.info("[setup] Setup complete.");
      } catch (err) {
        logger.error(
          `[setup] Download failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        logger.info("[setup] Make sure huggingface-cli is installed: pip install huggingface_hub");
      }
    });
}
