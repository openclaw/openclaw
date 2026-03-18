import os from "node:os";
import path from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/executorch";
import { registerExecuTorchCli } from "./src/cli.js";
import type { RunnerBackend } from "./src/native-addon.js";
import { createExecuTorchProvider } from "./src/provider.js";
import { RunnerManager } from "./src/runner-manager.js";
import {
  resolveExecuTorchRuntimeConfig,
  type ExecuTorchPluginConfig,
} from "./src/runtime-config.js";

function isBackendSupportedOnHost(backend: RunnerBackend): boolean {
  switch (backend) {
    case "metal":
      return os.platform() === "darwin" && os.arch() === "arm64";
    default:
      return false;
  }
}

const plugin = {
  id: "executorch",
  name: "ExecuTorch",
  description: "On-device speech-to-text via embedded ExecuTorch model plugins",

  register(api: OpenClawPluginApi) {
    const raw = (api.pluginConfig ?? {}) as ExecuTorchPluginConfig;
    const enabled = raw.enabled !== false;
    if (!enabled) {
      api.logger.info("[executorch] Disabled via config");
      return;
    }

    const resolved = resolveExecuTorchRuntimeConfig(raw);
    for (const warning of resolved.warnings) {
      api.logger.warn(`[executorch] ${warning}`);
    }
    const {
      modelPlugin,
      modelRoot,
      modelDir,
      backend,
      runtimeLibraryPath,
      modelPath,
      tokenizerPath,
      dataPath,
    } = resolved;

    if (!isBackendSupportedOnHost(backend)) {
      api.logger.warn(
        `[executorch] backend='${backend}' from modelPlugin='${modelPlugin.id}' is not supported on ${os.platform()}/${os.arch()}; plugin disabled`,
      );
      return;
    }

    let runner: RunnerManager | null = null;

    const getRunner = (): RunnerManager => {
      if (!runner) {
        runner = new RunnerManager({
          runtimeLibraryPath,
          backend,
          modelPath,
          modelFileCandidates: modelPlugin.modelFileCandidates,
          tokenizerPath,
          tokenizerFileCandidates: modelPlugin.tokenizerFileCandidates,
          dataPath,
          logger: api.logger,
        });
      }
      return runner;
    };

    const provider = createExecuTorchProvider(getRunner, {
      providerId: "executorch",
      modelId: modelPlugin.modelId,
    });

    if (typeof api.registerMediaProvider === "function") {
      api.registerMediaProvider(provider);
    } else {
      api.logger.warn(
        "[executorch] Plugin API does not support media provider registration in this runtime.",
      );
    }

    api.registerHook("gateway_start", () => {
      api.logger.info(
        `[executorch] Registered embedded STT provider (modelPlugin=${modelPlugin.id}, backend=${backend}, library=${runtimeLibraryPath}, models=${modelDir})`,
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
        `Transcribe audio on-device using embedded ExecuTorch ${modelPlugin.displayName} runtime. ` +
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
                  provider: provider.id,
                }),
              },
            ],
            details: {
              text: result.text,
              model: result.model,
              provider: provider.id,
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
          respond(true, { text: result.text, model: result.model, provider: provider.id });
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
          modelPlugin: modelPlugin.id,
          modelId: modelPlugin.modelId,
          backend,
          runtimeLibraryPath,
          modelRoot,
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
          modelPlugin,
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
