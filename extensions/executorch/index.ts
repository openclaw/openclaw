import os from "node:os";
import path from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/executorch";
import { registerExecuTorchCli } from "./src/cli.js";
import type { RunnerBackend } from "./src/native-addon.js";
import { createExecuTorchProvider } from "./src/provider.js";
import { RunnerManager } from "./src/runner-manager.js";

type ExecuTorchPluginConfig = {
  enabled?: boolean;
  backend?: string;
  runtimeLibraryPath?: string;
  modelDir?: string;
  modelPath?: string;
  tokenizerPath?: string;
  dataPath?: string;
};

const DEFAULT_RUNTIME_LIBRARY_PATH =
  process.env.OPENCLAW_EXECUTORCH_RUNTIME_LIBRARY?.trim() ||
  path.join(os.homedir(), ".openclaw/lib", defaultRuntimeLibraryFileName());
const DEFAULT_MODEL_ROOT =
  process.env.OPENCLAW_EXECUTORCH_MODEL_ROOT?.trim() ||
  path.join(os.homedir(), ".openclaw/models/parakeet");
const DEFAULT_MODEL_DIR = path.join(DEFAULT_MODEL_ROOT, "parakeet-tdt-metal");
const DEFAULT_MODEL_FILE = "model.pte";
const DEFAULT_TOKENIZER_FILE = "tokenizer.model";
const DEFAULT_BACKEND: RunnerBackend = "metal";

function defaultRuntimeLibraryFileName(): string {
  if (os.platform() === "darwin") return "libparakeet_tdt_runtime.dylib";
  if (os.platform() === "win32") return "parakeet_tdt_runtime.dll";
  return "libparakeet_tdt_runtime.so";
}

function isMetalHost(): boolean {
  return os.platform() === "darwin" && os.arch() === "arm64";
}

const plugin = {
  id: "executorch",
  name: "ExecuTorch",
  description: "On-device speech-to-text via embedded ExecuTorch Parakeet-TDT (Metal)",

  register(api: OpenClawPluginApi) {
    const raw = (api.pluginConfig ?? {}) as ExecuTorchPluginConfig;
    const enabled = raw.enabled !== false;
    if (!enabled) {
      api.logger.info("[executorch] Disabled via config");
      return;
    }

    if (!isMetalHost()) {
      api.logger.warn(
        `[executorch] Parakeet metal runtime is only supported on darwin/arm64 (found ${os.platform()}/${os.arch()}); plugin disabled`,
      );
      return;
    }

    const requestedBackend = raw.backend?.trim();
    if (requestedBackend && requestedBackend !== DEFAULT_BACKEND) {
      api.logger.warn(
        `[executorch] backend='${requestedBackend}' is not supported for this migration; forcing backend=metal`,
      );
    }
    const backend = DEFAULT_BACKEND;

    const modelDir = raw.modelDir?.trim() || DEFAULT_MODEL_DIR;
    const runtimeLibraryPath = raw.runtimeLibraryPath?.trim() || DEFAULT_RUNTIME_LIBRARY_PATH;
    const modelPath = raw.modelPath?.trim() || path.join(modelDir, DEFAULT_MODEL_FILE);
    const tokenizerPath = raw.tokenizerPath?.trim() || path.join(modelDir, DEFAULT_TOKENIZER_FILE);
    const dataPath = raw.dataPath?.trim() || undefined;

    let runner: RunnerManager | null = null;

    const getRunner = (): RunnerManager => {
      if (!runner) {
        runner = new RunnerManager({
          runtimeLibraryPath,
          backend,
          modelPath,
          tokenizerPath,
          dataPath,
          logger: api.logger,
        });
      }
      return runner;
    };

    const provider = createExecuTorchProvider(getRunner);

    if (typeof api.registerMediaProvider === "function") {
      api.registerMediaProvider(provider);
    } else {
      api.logger.warn(
        "[executorch] Plugin API does not support media provider registration in this runtime.",
      );
    }

    api.registerHook("gateway_start", () => {
      api.logger.info(
        `[executorch] Registered embedded STT provider (backend=${backend}, library=${runtimeLibraryPath}, models=${modelDir})`,
      );

      try {
        const { loadNativeExecuTorchAddon } = require("./src/native-addon.js");
        loadNativeExecuTorchAddon();
        api.logger.info("[executorch] Native addon loaded successfully");
      } catch {
        api.logger.warn(
          "[executorch] Native addon not available — on-device STT will not work until the addon is built. " +
            "See extensions/executorch/README.md for setup instructions.",
        );
      }
    });

    api.registerTool({
      name: "executorch_transcribe",
      label: "ExecuTorch Transcribe",
      description:
        "Transcribe audio on-device using embedded ExecuTorch Parakeet runtime. " +
        "No cloud API needed.",
      parameters: {
        type: "object" as const,
        properties: {
          file_path: {
            type: "string" as const,
            description: "Path to the audio file to transcribe",
          },
        },
        required: ["file_path"] as const,
      },
      async execute(_toolCallId: string, params: Record<string, unknown>) {
        const filePath = typeof params.file_path === "string" ? params.file_path.trim() : "";
        if (!filePath) {
          const payload = { error: "file_path required" };
          return {
            content: [{ type: "text" as const, text: JSON.stringify(payload) }],
            details: payload,
          };
        }
        try {
          const fs = await import("node:fs/promises");
          const buffer = await fs.readFile(filePath);
          const result = await provider.transcribeAudio!({
            buffer,
            fileName: path.basename(filePath),
            apiKey: "local",
            timeoutMs: 120_000,
          });
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  text: result.text,
                  model: result.model,
                  provider: "executorch",
                }),
              },
            ],
            details: {
              text: result.text,
              model: result.model,
              provider: "executorch",
            },
          };
        } catch (err) {
          const payload = { error: err instanceof Error ? err.message : String(err) };
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(payload),
              },
            ],
            details: payload,
          };
        }
      },
    });

    api.registerGatewayMethod(
      "executorch.transcribe",
      async ({
        params,
        respond,
      }: {
        params?: Record<string, unknown>;
        respond: (ok: boolean, payload?: unknown) => void;
      }) => {
        try {
          const filePath = typeof params?.filePath === "string" ? params.filePath.trim() : "";
          if (!filePath) {
            respond(false, { error: "filePath required" });
            return;
          }
          const fs = await import("node:fs/promises");
          const buffer = await fs.readFile(filePath);
          const result = await provider.transcribeAudio!({
            buffer,
            fileName: path.basename(filePath),
            apiKey: "local",
            timeoutMs: 120_000,
          });
          respond(true, { text: result.text, model: result.model, provider: "executorch" });
        } catch (err) {
          respond(false, { error: err instanceof Error ? err.message : String(err) });
        }
      },
    );

    api.registerGatewayMethod(
      "executorch.status",
      async ({ respond }: { respond: (ok: boolean, payload?: unknown) => void }) => {
        respond(true, {
          available: true,
          platform: `${os.platform()}/${os.arch()}`,
          backend,
          runtimeLibraryPath,
          modelPath,
          tokenizerPath,
          dataPath,
          modelDir,
          runnerState: runner?.state ?? "unloaded",
          runnerAlive: runner?.isAlive ?? false,
        });
      },
    );

    api.registerCli(
      ({ program }) =>
        registerExecuTorchCli(program, {
          backend,
          runtimeLibraryPath,
          modelPath,
          tokenizerPath,
          dataPath,
          logger: api.logger,
        }),
      { commands: ["executorch"] },
    );

    api.registerService({
      id: "executorch",
      start: async () => {
        api.logger.info("[executorch] Service started — runner will load on first transcription");
      },
      stop: async () => {
        runner?.stop();
        runner = null;
        api.logger.info("[executorch] Service stopped");
      },
    });
  },
};

export default plugin;
