import os from "node:os";
import path from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/executorch";
import { registerExecuTorchCli } from "./src/cli.js";
import type { RunnerBackend } from "./src/native-addon.js";
import { createExecuTorchProvider } from "./src/provider.js";
import { RunnerManager } from "./src/runner-manager.js";

type ExecuTorchPluginConfig = {
  enabled?: boolean;
  backend?: RunnerBackend;
  runtimeLibraryPath?: string;
  modelDir?: string;
  modelPath?: string;
  tokenizerPath?: string;
  preprocessorPath?: string;
  dataPath?: string;
};

const DEFAULT_RUNTIME_LIBRARY_PATH =
  process.env.OPENCLAW_EXECUTORCH_RUNTIME_LIBRARY?.trim() ||
  path.join(os.homedir(), ".openclaw/lib", defaultRuntimeLibraryFileName());
const DEFAULT_MODEL_ROOT =
  process.env.OPENCLAW_EXECUTORCH_MODEL_ROOT?.trim() ||
  path.join(os.homedir(), ".openclaw/models/voxtral");
const DEFAULT_MODEL_DIR_BY_BACKEND: Record<RunnerBackend, string> = {
  metal: path.join(DEFAULT_MODEL_ROOT, "voxtral-realtime-metal"),
  xnnpack: path.join(DEFAULT_MODEL_ROOT, "voxtral-realtime-xnnpack"),
  cuda: path.join(DEFAULT_MODEL_ROOT, "voxtral-realtime-cuda"),
};
const DEFAULT_MODEL_FILE_BY_BACKEND: Record<RunnerBackend, string> = {
  metal: "model-metal-fpa4w.pte",
  xnnpack: "model-xnnpack-8da4w.pte",
  cuda: "model.pte",
};

function defaultRuntimeLibraryFileName(): string {
  if (os.platform() === "darwin") return "libvoxtral_realtime_runtime.dylib";
  if (os.platform() === "win32") return "voxtral_realtime_runtime.dll";
  return "libvoxtral_realtime_runtime.so";
}

function isBackendSupportedOnHost(backend: RunnerBackend): boolean {
  if (backend === "metal") {
    return os.platform() === "darwin" && os.arch() === "arm64";
  }
  return true;
}

const plugin = {
  id: "executorch",
  name: "ExecuTorch",
  description: "On-device speech-to-text via ExecuTorch Voxtral — privacy-first, zero cloud STT",

  register(api: OpenClawPluginApi) {
    const raw = (api.pluginConfig ?? {}) as ExecuTorchPluginConfig;
    const enabled = raw.enabled !== false;
    if (!enabled) {
      api.logger.info("[executorch] Disabled via config");
      return;
    }

    const defaultBackend: RunnerBackend =
      os.platform() === "darwin" && os.arch() === "arm64" ? "metal" : "xnnpack";
    const backend = raw.backend ?? defaultBackend;
    if (!isBackendSupportedOnHost(backend)) {
      api.logger.warn(
        `[executorch] Backend '${backend}' is not supported on ${os.platform()}/${os.arch()}; plugin disabled`,
      );
      return;
    }

    const modelDir = raw.modelDir?.trim() || DEFAULT_MODEL_DIR_BY_BACKEND[backend];
    const runtimeLibraryPath = raw.runtimeLibraryPath?.trim() || DEFAULT_RUNTIME_LIBRARY_PATH;
    const modelPath =
      raw.modelPath?.trim() || path.join(modelDir, DEFAULT_MODEL_FILE_BY_BACKEND[backend]);
    const tokenizerPath = raw.tokenizerPath?.trim() || path.join(modelDir, "tekken.json");
    const preprocessorPath =
      raw.preprocessorPath?.trim() || path.join(modelDir, "preprocessor.pte");
    const dataPath =
      raw.dataPath?.trim() ||
      (backend === "cuda" ? path.join(modelDir, "aoti_cuda_blob.ptd") : undefined);

    let runner: RunnerManager | null = null;

    const getRunner = (): RunnerManager => {
      if (!runner) {
        runner = new RunnerManager({
          runtimeLibraryPath,
          backend,
          modelPath,
          tokenizerPath,
          preprocessorPath,
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
        "Transcribe audio on-device using embedded ExecuTorch Voxtral runtime. " +
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
          preprocessorPath,
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
          preprocessorPath,
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
