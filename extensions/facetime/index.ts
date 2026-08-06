import {
  ErrorCodes,
  errorShape,
  type GatewayRequestHandlerOptions,
} from "openclaw/plugin-sdk/gateway-runtime";
import {
  definePluginEntry,
  type OpenClawPluginApi,
  type OpenClawPluginDefinition,
} from "openclaw/plugin-sdk/plugin-entry";
import { createFaceTimeRuntime, type FaceTimeRuntime } from "./runtime-entry.js";
import {
  resolveFaceTimeConfig,
  validateFaceTimeConfig,
  type FaceTimeConfig,
} from "./src/config.js";
import { inspectFaceTimeDriver } from "./src/driver-setup.js";
import { formatErrorMessage } from "./src/errors.js";
import { resolvePluginRoot } from "./src/plugin-paths.js";
import { stopRetainedRuntime } from "./src/runtime-lifecycle.js";
import { runFaceTimeSetup } from "./src/setup.js";
import { createFaceTimeCallTool, resolveFaceTimeToolApproval } from "./src/tool.js";

const faceTimeConfigSchema = {
  parse(value: unknown): FaceTimeConfig {
    return resolveFaceTimeConfig(value);
  },
  uiHints: {
    enabled: { label: "Enable FaceTime Voice" },
    helperHost: { label: "Helper Host", advanced: true },
    helperPort: { label: "Helper Port", advanced: true },
    whitelistHandles: { label: "Allowed FaceTime Handles" },
    "realtime.provider": { label: "Realtime Provider", advanced: true },
    "realtime.model": { label: "Realtime Model", advanced: true },
    "realtime.voice": { label: "Realtime Voice", advanced: true },
    "realtime.sessionKey": { label: "Agent Session Key", advanced: true },
    "realtime.brain": { label: "Brain Mode", advanced: true },
    "realtime.toolPolicy": { label: "Tool Policy", advanced: true },
  },
};

const faceTimePlugin: OpenClawPluginDefinition = definePluginEntry({
  id: "facetime",
  name: "FaceTime",
  description: "Experimental private FaceTime realtime voice carrier for OpenClaw agents",
  configSchema: faceTimeConfigSchema,
  register(api: OpenClawPluginApi) {
    const config = resolveFaceTimeConfig(api.pluginConfig);
    const validation = validateFaceTimeConfig(config);
    const pluginRoot = resolvePluginRoot(import.meta.url);
    let runtimePromise: Promise<FaceTimeRuntime> | undefined;

    const ensureRuntime = async () => {
      if (!config.enabled) {
        throw new Error("facetime disabled in plugin config");
      }
      if (!validation.valid) {
        throw new Error(validation.errors.join("; "));
      }
      runtimePromise ??= createFaceTimeRuntime({
        config,
        fullConfig: api.config,
        runtime: api.runtime,
        logger: api.logger,
        pluginRoot,
      }).catch((error) => {
        runtimePromise = undefined;
        throw error;
      });
      return await runtimePromise;
    };

    api.registerTool(() => createFaceTimeCallTool({ ensureRuntime }), {
      name: "facetime_call",
    });
    api.on("before_tool_call", (event) => {
      if (event.toolName !== "facetime_call") {
        return;
      }
      return resolveFaceTimeToolApproval(event.params);
    });

    api.registerService({
      id: "facetime-runtime",
      async start() {
        if (!config.enabled || !validation.valid) {
          return;
        }
        try {
          await ensureRuntime();
        } catch (error) {
          api.logger.warn(`[facetime] startup skipped: ${formatErrorMessage(error)}`);
        }
      },
      async stop() {
        await stopRetainedRuntime(runtimePromise, (stopped) => {
          if (runtimePromise === stopped) {
            runtimePromise = undefined;
          }
        });
      },
    });

    api.registerGatewayMethod(
      "facetime.status",
      async ({ respond }: GatewayRequestHandlerOptions) => {
        try {
          const rt = await ensureRuntime();
          respond(true, await rt.status());
        } catch (error) {
          respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatErrorMessage(error)));
        }
      },
      { scope: "operator.read" },
    );

    api.registerGatewayMethod(
      "facetime.setup",
      async ({ respond }: GatewayRequestHandlerOptions) => {
        try {
          let rt: FaceTimeRuntime;
          try {
            rt = await ensureRuntime();
          } catch (runtimeError) {
            respond(
              true,
              await runFaceTimeSetup({
                config,
                pluginRoot,
                runCommandWithTimeout: api.runtime.system.runCommandWithTimeout,
                runtimeError: formatErrorMessage(runtimeError),
              }),
            );
            return;
          }
          respond(true, await rt.setup());
        } catch (error) {
          respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatErrorMessage(error)));
        }
      },
      { scope: "operator.read" },
    );

    api.registerGatewayMethod(
      "facetime.driverStatus",
      async ({ respond }: GatewayRequestHandlerOptions) => {
        try {
          const status = await inspectFaceTimeDriver({
            pluginRoot,
            runCommandWithTimeout: api.runtime.system.runCommandWithTimeout,
          });
          respond(true, { status });
        } catch (error) {
          respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatErrorMessage(error)));
        }
      },
      { scope: "operator.read" },
    );

    api.registerGatewayMethod(
      "facetime.installDriver",
      async ({ respond }: GatewayRequestHandlerOptions) => {
        try {
          const current = await ensureRuntime();
          const result = await current.installDriver();
          respond(true, { ok: true, ...result });
        } catch (error) {
          respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatErrorMessage(error)));
        }
      },
      { scope: "operator.admin" },
    );

    api.registerGatewayMethod(
      "facetime.testAudio",
      async ({ params, respond }: GatewayRequestHandlerOptions) => {
        try {
          const rt = await ensureRuntime();
          const phrase =
            params && typeof params === "object" && "phrase" in params
              ? (params as { phrase?: unknown }).phrase
              : undefined;
          respond(true, { ok: true, ...(await rt.testAudio({ phrase })) });
        } catch (error) {
          respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatErrorMessage(error)));
        }
      },
      { scope: "operator.write" },
    );

    api.registerGatewayMethod(
      "facetime.preflight",
      async ({ respond }: GatewayRequestHandlerOptions) => {
        try {
          const rt = await ensureRuntime();
          respond(true, await rt.preflight());
        } catch (error) {
          respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatErrorMessage(error)));
        }
      },
      { scope: "operator.read" },
    );

    api.registerGatewayMethod(
      "facetime.dial",
      async ({ params, respond }: GatewayRequestHandlerOptions) => {
        try {
          const rt = await ensureRuntime();
          const record = params && typeof params === "object" ? params : {};
          const handle = "handle" in record ? (record as { handle?: unknown }).handle : undefined;
          const mode = "mode" in record ? (record as { mode?: unknown }).mode : undefined;
          respond(true, { ok: true, ...(await rt.dial({ handle, mode })) });
        } catch (error) {
          respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatErrorMessage(error)));
        }
      },
      { scope: "operator.write" },
    );

    api.registerGatewayMethod(
      "facetime.hangup",
      async ({ params, respond }: GatewayRequestHandlerOptions) => {
        try {
          const rt = await ensureRuntime();
          const callUUID =
            params && typeof params === "object" && "callUUID" in params
              ? (params as { callUUID?: unknown }).callUUID
              : undefined;
          respond(true, { ok: true, ...(await rt.hangup({ callUUID })) });
        } catch (error) {
          respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatErrorMessage(error)));
        }
      },
      { scope: "operator.write" },
    );
  },
});

export default faceTimePlugin;
