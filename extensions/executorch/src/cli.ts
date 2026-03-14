import os from "node:os";
import path from "node:path";
import type { Command } from "commander";
import type { PluginLogger } from "openclaw/plugin-sdk/executorch";
import type { RunnerBackend } from "./native-addon.js";
import { RunnerManager } from "./runner-manager.js";
import { ensureRuntimeLibraryLoadable } from "./runtime-library.js";
import { PrivateVoiceAgent } from "./voice-agent.js";

export type ExecuTorchCliOptions = {
  backend: RunnerBackend;
  runtimeLibraryPath: string;
  modelPath: string;
  tokenizerPath: string;
  preprocessorPath: string;
  dataPath?: string;
  logger: PluginLogger;
};

const DEFAULT_MODEL_ROOT =
  process.env.OPENCLAW_EXECUTORCH_MODEL_ROOT?.trim() ||
  path.join(os.homedir(), ".openclaw/models/voxtral");

const DEFAULT_MODEL_DIR_BY_BACKEND: Record<RunnerBackend, string> = {
  metal: path.join(DEFAULT_MODEL_ROOT, "voxtral-realtime-metal"),
  xnnpack: path.join(DEFAULT_MODEL_ROOT, "voxtral-realtime-xnnpack"),
  cuda: path.join(DEFAULT_MODEL_ROOT, "voxtral-realtime-cuda"),
};

const MODEL_REPO_BY_BACKEND: Partial<Record<RunnerBackend, string>> = {
  metal: "younghan-meta/Voxtral-Mini-4B-Realtime-2602-ExecuTorch-Metal",
  xnnpack: "younghan-meta/Voxtral-Mini-4B-Realtime-2602-ExecuTorch-XNNPACK",
};

type SetupFileGroup = {
  label: string;
  candidates: string[];
};

const REQUIRED_SETUP_FILE_GROUPS: Record<RunnerBackend, SetupFileGroup[]> = {
  metal: [
    {
      label: "model",
      candidates: [
        "model-metal-fpa4w-streaming.pte",
        "model-metal-fpa4w.pte",
        "model-metal-int4-streaming.pte",
        "model-metal-int4.pte",
        "model-streaming.pte",
        "model.pte",
      ],
    },
    {
      label: "preprocessor",
      candidates: ["preprocessor-streaming.pte", "preprocessor.pte"],
    },
    {
      label: "tokenizer",
      candidates: ["tekken.json"],
    },
  ],
  xnnpack: [
    {
      label: "model",
      candidates: [
        "model-xnnpack-8da4w-streaming.pte",
        "model-xnnpack-8da4w.pte",
        "model-streaming.pte",
        "model.pte",
      ],
    },
    {
      label: "preprocessor",
      candidates: ["preprocessor-streaming.pte", "preprocessor.pte"],
    },
    {
      label: "tokenizer",
      candidates: ["tekken.json"],
    },
  ],
  cuda: [
    {
      label: "model",
      candidates: [
        "model-cuda-streaming.pte",
        "model-cuda.pte",
        "model-streaming.pte",
        "model.pte",
      ],
    },
    {
      label: "preprocessor",
      candidates: ["preprocessor-streaming.pte", "preprocessor.pte"],
    },
    {
      label: "tokenizer",
      candidates: ["tekken.json"],
    },
    {
      label: "CUDA data file",
      candidates: ["aoti_cuda_blob.ptd"],
    },
  ],
};

const RUNTIME_REPO_BY_BACKEND = MODEL_REPO_BY_BACKEND;

const MAC_TALK_MODE_FILE_GROUPS: SetupFileGroup[] = [
  {
    label: "Talk Mode streaming model",
    candidates: [
      "model-metal-fpa4w-streaming.pte",
      "model-metal-int4-streaming.pte",
      "model-streaming.pte",
    ],
  },
  // Only accept streaming preprocessor so we download it even when preprocessor.pte exists.
  {
    label: "Talk Mode preprocessor",
    candidates: ["preprocessor-streaming.pte"],
  },
];

function createRunner(options: ExecuTorchCliOptions): RunnerManager {
  return new RunnerManager({
    backend: options.backend,
    runtimeLibraryPath: options.runtimeLibraryPath,
    modelPath: options.modelPath,
    tokenizerPath: options.tokenizerPath,
    preprocessorPath: options.preprocessorPath,
    dataPath: options.dataPath,
    logger: options.logger,
  });
}

export function registerExecuTorchCli(program: Command, options: ExecuTorchCliOptions): void {
  const et = program.command("executorch").description("ExecuTorch on-device voice commands");
  const defaultModelDir = DEFAULT_MODEL_DIR_BY_BACKEND[options.backend];

  et.command("status")
    .description("Check ExecuTorch runner and model availability")
    .action(async () => {
      const {
        logger,
        backend,
        runtimeLibraryPath,
        modelPath,
        tokenizerPath,
        preprocessorPath,
        dataPath,
      } = options;

      const fs = await import("node:fs/promises");
      const checks = [
        { label: "Platform", value: `${os.platform()}/${os.arch()}`, ok: true },
        { label: "Backend", value: backend, ok: true },
        { label: "Runtime library", value: runtimeLibraryPath, ok: false },
        { label: "Model file", value: modelPath, ok: false },
        { label: "Tokenizer", value: tokenizerPath, ok: false },
        { label: "Preprocessor", value: preprocessorPath, ok: false },
      ];
      if (backend === "cuda") {
        checks.push({ label: "CUDA data file", value: dataPath ?? "(missing)", ok: false });
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
          "\nSome components are missing. Run 'openclaw executorch setup' to fetch models and ensure runtime library is built.",
        );
      } else {
        logger.info("\nAll components available. Ready for embedded on-device transcription.");
      }
    });

  et.command("transcribe")
    .description("Transcribe an audio file using on-device ExecuTorch Voxtral")
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

  et.command("voice-agent")
    .description("Start the Private Voice Agent (ExecuTorch STT + Ollama LLM + Edge TTS)")
    .option("--ollama-model <model>", "Ollama model to use", "llama3.2:3b")
    .option("--ollama-url <url>", "Ollama base URL", "http://localhost:11434")
    .option("--tts-voice <voice>", "Edge TTS voice", "en-US-AriaNeural")
    .option("--record-duration <seconds>", "Recording duration per turn", "5")
    .option("--max-turns <n>", "Maximum number of turns (0 = unlimited)", "0")
    .action(
      async (opts: {
        ollamaModel: string;
        ollamaUrl: string;
        ttsVoice: string;
        recordDuration: string;
        maxTurns: string;
      }) => {
        const { logger } = options;
        const agent = new PrivateVoiceAgent({
          backend: options.backend,
          runtimeLibraryPath: options.runtimeLibraryPath,
          modelPath: options.modelPath,
          tokenizerPath: options.tokenizerPath,
          preprocessorPath: options.preprocessorPath,
          dataPath: options.dataPath,
          ollamaModel: opts.ollamaModel,
          ollamaBaseUrl: opts.ollamaUrl,
          ttsVoice: opts.ttsVoice,
          logger,
        });

        const maxTurns = Number.parseInt(opts.maxTurns, 10) || 0;
        const recordDuration = Number.parseInt(opts.recordDuration, 10) || 5;

        process.on("SIGINT", () => {
          logger.info("\n[voice-agent] Shutting down...");
          agent.stop();
          process.exit(0);
        });

        try {
          await agent.runLoop({
            maxTurns: maxTurns > 0 ? maxTurns : undefined,
            recordDuration,
          });
        } finally {
          agent.stop();
        }
      },
    );

  et.command("setup")
    .description("Download ExecuTorch Voxtral model files")
    .option("--backend <backend>", "Target backend (xnnpack|cuda|metal)", options.backend)
    .option("--model-dir <dir>", "Target directory for model files", defaultModelDir)
    .action(async (opts: { modelDir: string; backend: string }) => {
      const { logger } = options;
      const targetDir = opts.modelDir;
      const backend = (opts.backend || options.backend).trim() as RunnerBackend;
      if (!["xnnpack", "cuda", "metal"].includes(backend)) {
        logger.error("[setup] backend must be one of: xnnpack, cuda, metal");
        return;
      }
      const fs = await import("node:fs/promises");
      const { execFile: execFileCb } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const execFileAsync = promisify(execFileCb);
      const repo = MODEL_REPO_BY_BACKEND[backend];
      const runtimeRepo = RUNTIME_REPO_BY_BACKEND[backend];
      const runtimeDir = path.dirname(options.runtimeLibraryPath);
      const runtimeFile = path.basename(options.runtimeLibraryPath);

      if (!repo) {
        logger.warn("[setup] CUDA model bundle is not configured yet in this plugin.");
        logger.warn(
          `[setup] Please place files manually in ${targetDir}: ${REQUIRED_SETUP_FILE_GROUPS.cuda.flatMap((group) => group.candidates).join(", ")}`,
        );
        return;
      }

      logger.info(`[setup] Downloading ${backend} models to ${targetDir}...`);
      logger.info(`[setup] Source: huggingface.co/${repo}`);

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
        sourceRepo,
        required,
        makeExecutable,
      }: {
        label: string;
        candidates: string[];
        localDir: string;
        sourceRepo: string;
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
              ["download", sourceRepo, candidate, "--local-dir", localDir],
              {
                timeout: 600_000,
              },
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
          `${label} not found. Tried: ${candidates.join(", ")} from huggingface.co/${sourceRepo}.` +
          details;
        if (required) {
          throw new Error(message);
        }
        logger.warn(`[setup] Optional ${message}`);
        return null;
      };

      try {
        for (const group of REQUIRED_SETUP_FILE_GROUPS[backend]) {
          await ensureGroup({
            label: group.label,
            candidates: group.candidates,
            localDir: targetDir,
            sourceRepo: repo,
            required: true,
          });
        }
        logger.info("[setup] Core model files verified.");
        logger.info(`[setup] Model directory: ${targetDir}`);

        const runtimeSourceRepo = runtimeRepo ?? repo;
        if (runtimeSourceRepo) {
          await ensureGroup({
            label: "runtime library",
            candidates: [runtimeFile],
            localDir: runtimeDir,
            sourceRepo: runtimeSourceRepo,
            required: false,
          });
          if (await fileExists(options.runtimeLibraryPath)) {
            logger.info(`[setup] Runtime library path: ${options.runtimeLibraryPath}`);
          }
        } else {
          logger.warn(
            `[setup] No runtime repo configured for backend=${backend}. ` +
              `Please place runtime library at ${options.runtimeLibraryPath}.`,
          );
        }

        if (backend === "metal" && os.platform() === "darwin") {
          logger.info("[setup] Preparing macOS Talk Mode assets...");
          for (const group of MAC_TALK_MODE_FILE_GROUPS) {
            await ensureGroup({
              label: group.label,
              candidates: group.candidates,
              localDir: targetDir,
              sourceRepo: repo,
              required: true,
            });
          }
        }

        logger.info("[setup] Setup complete.");
      } catch (err) {
        logger.error(
          `[setup] Download failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        logger.info("[setup] Make sure huggingface-cli is installed: pip install huggingface_hub");
      }
    });
}
