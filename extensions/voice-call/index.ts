// Voice Call plugin entrypoint registers its OpenClaw integration.
import { AsyncLocalStorage } from "node:async_hooks";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { ErrorCodes, errorShape } from "openclaw/plugin-sdk/gateway-runtime";
import { resolveGlobalSingleton } from "openclaw/plugin-sdk/global-singleton";
import type { PluginServiceSchedulerV1 } from "openclaw/plugin-sdk/plugin-entry";
import { normalizeAgentId, parseAgentSessionKey } from "openclaw/plugin-sdk/routing";
import { resolvePluginServiceScheduler } from "openclaw/plugin-sdk/runtime";
import {
  asNonArrayRecord as asParamRecord,
  asOptionalRecord,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { jsonResult as json } from "openclaw/plugin-sdk/tool-results";
import {
  definePluginEntry,
  type GatewayRequestHandlerOptions,
  type OpenClawPluginApi,
} from "./api.js";
import { VOICE_CALL_CLI_DESCRIPTOR } from "./cli-output-mode.js";
import { createVoiceCallRuntime, type VoiceCallRuntime } from "./runtime-entry.js";
import {
  createVoiceCallCommandService,
  VoiceCallCommandInputError,
} from "./src/command-service.js";
import {
  VoiceCallConfigSchema,
  resolveVoiceCallConfig,
  validateProviderConfig,
  type VoiceCallConfig,
} from "./src/config.js";
import { createVoiceCallContinueOperationStore } from "./src/gateway-continue-operation.js";
import { resolveActiveVoiceCallToolScope } from "./src/tool-call-scope.js";
import { VoiceCallToolSchema } from "./src/tool-schema.js";

const VOICE_CALL_WRITE_METHOD_SCOPE = { scope: "operator.write" as const };
const VOICE_CALL_READ_METHOD_SCOPE = { scope: "operator.read" as const };

const voiceCallConfigSchema = {
  parse(value: unknown): VoiceCallConfig {
    const config = asOptionalRecord(value) ?? {};
    const enabled = typeof config.enabled === "boolean" ? config.enabled : true;
    return VoiceCallConfigSchema.parse({
      ...config,
      enabled,
      provider: config.provider ?? (enabled ? "mock" : undefined),
    });
  },
};

function isCliOnlyProcess(): boolean {
  return process.env.OPENCLAW_CLI === "1" && !process.argv.slice(2).includes("gateway");
}

const VOICE_CALL_RUNTIME_COORDINATOR_KEY = Symbol.for("openclaw.voice-call.runtimeCoordinator");

type VoiceCallRuntimeGeneration = {
  retired: boolean;
  scheduler?: PluginServiceSchedulerV1;
  runInServiceContext?: <T>(run: () => T) => T;
  serviceHealth?: Parameters<
    Parameters<OpenClawPluginApi["registerService"]>[0]["start"]
  >[0]["serviceHealth"];
};

type VoiceCallRuntimeRegistration = {
  generation: VoiceCallRuntimeGeneration;
  ensureRuntime: () => Promise<VoiceCallRuntime>;
};

type VoiceCallRuntimeSlot = {
  owner: VoiceCallRuntimeGeneration;
  promise: Promise<VoiceCallRuntime>;
  stopPromise?: Promise<void>;
};

type VoiceCallRuntimeCoordinator = {
  current?: VoiceCallRuntimeRegistration;
  slot?: VoiceCallRuntimeSlot;
};

class VoiceCallRuntimeLifecycleError extends Error {}

function getVoiceCallRuntimeCoordinator(): VoiceCallRuntimeCoordinator {
  return resolveGlobalSingleton(VOICE_CALL_RUNTIME_COORDINATOR_KEY, () => ({}));
}

function activateVoiceCallRuntimeGeneration(
  coordinator: VoiceCallRuntimeCoordinator,
  registration: VoiceCallRuntimeRegistration,
  generation: VoiceCallRuntimeGeneration,
): void {
  if (generation.retired) {
    throw new VoiceCallRuntimeLifecycleError(
      "Voice call runtime generation is retired; use the current plugin registration",
    );
  }
  if (coordinator.current !== registration) {
    if (coordinator.current) {
      coordinator.current.generation.retired = true;
    }
    coordinator.current = registration;
  }
}

function stopVoiceCallRuntimeGeneration(
  coordinator: VoiceCallRuntimeCoordinator,
  generation: VoiceCallRuntimeGeneration,
): Promise<void> {
  const ownedSlot = coordinator.slot?.owner === generation ? coordinator.slot : undefined;
  if (!ownedSlot) {
    return Promise.resolve();
  }
  return (ownedSlot.stopPromise ??= ownedSlot.promise
    .then((runtime) => runtime.stop())
    .finally(() => {
      if (coordinator.slot === ownedSlot) {
        coordinator.slot = undefined;
      }
    }));
}

export default definePluginEntry({
  id: "voice-call",
  name: "Voice Call",
  description: "Voice-call plugin with Telnyx/Twilio/Plivo providers",
  configSchema: voiceCallConfigSchema,
  register(api: OpenClawPluginApi) {
    const config = resolveVoiceCallConfig(voiceCallConfigSchema.parse(api.pluginConfig));
    const validation = validateProviderConfig(config);

    const runtimeCoordinator = getVoiceCallRuntimeCoordinator();
    const runtimeRegistration: VoiceCallRuntimeRegistration = {
      generation: { retired: false },
      ensureRuntime: () => ensureRegisteredRuntime(),
    };
    const continueOperationStore = createVoiceCallContinueOperationStore({
      config,
      coreConfig: api.config as OpenClawConfig,
    });
    const activateRuntimeGeneration = (generation: VoiceCallRuntimeGeneration) =>
      activateVoiceCallRuntimeGeneration(runtimeCoordinator, runtimeRegistration, generation);
    const ensureRuntimeForGeneration = async (
      runtimeGeneration: VoiceCallRuntimeGeneration,
    ): Promise<VoiceCallRuntime> => {
      activateRuntimeGeneration(runtimeGeneration);
      if (!config.enabled) {
        throw new Error("Voice call disabled in plugin config");
      }
      if (!validation.valid) {
        throw new Error(validation.errors.join("; "));
      }

      if (
        (config.reports.enabled || config.live.transcript) &&
        !runtimeGeneration.runInServiceContext
      ) {
        throw new VoiceCallRuntimeLifecycleError(
          "Voice call requester reporting requires service startup",
        );
      }

      const previous = runtimeCoordinator.slot;
      if (previous && (previous.owner !== runtimeGeneration || previous.stopPromise)) {
        await stopVoiceCallRuntimeGeneration(runtimeCoordinator, previous.owner);
        activateRuntimeGeneration(runtimeGeneration);
      }
      if (!runtimeCoordinator.slot) {
        const scheduler = runtimeGeneration.scheduler;
        if (!scheduler || scheduler.signal.aborted) {
          throw new VoiceCallRuntimeLifecycleError(
            "Voice call service is not running; start the Gateway and retry",
          );
        }
        runtimeCoordinator.slot = {
          owner: runtimeGeneration,
          promise: createVoiceCallRuntime({
            scheduler,
            config,
            coreConfig: api.config as OpenClawConfig,
            fullConfig: api.config,
            agentRuntime: api.runtime.agent,
            stateRuntime: api.runtime.state,
            ttsRuntime: api.runtime.tts,
            deliveryRuntime: api.runtime,
            runInServiceContext: runtimeGeneration.runInServiceContext,
            logger: api.logger,
          }),
        };
      }
      const slot = runtimeCoordinator.slot;
      let runtime: VoiceCallRuntime;
      try {
        runtime = await slot.promise;
      } catch (err) {
        if (runtimeCoordinator.slot === slot && !slot.stopPromise) {
          runtimeCoordinator.slot = undefined;
        }
        throw err;
      }
      activateRuntimeGeneration(runtimeGeneration);
      return runtime;
    };
    const ensureRegisteredRuntime = async (
      runtimeGeneration = runtimeRegistration.generation,
    ): Promise<VoiceCallRuntime> => {
      try {
        const runtime = await ensureRuntimeForGeneration(runtimeGeneration);
        runtimeGeneration.serviceHealth?.clearFailure();
        return runtime;
      } catch (err) {
        if (!(err instanceof VoiceCallRuntimeLifecycleError)) {
          runtimeGeneration.serviceHealth?.reportFailure(err);
        }
        throw err;
      }
    };

    // Callers follow the service owner; only service.start may replace an existing owner.
    const ensureRuntime = () => (runtimeCoordinator.current ?? runtimeRegistration).ensureRuntime();
    const commands = createVoiceCallCommandService(ensureRuntime);
    const registerGatewayCommand = (
      method: string,
      handler: (options: GatewayRequestHandlerOptions) => unknown,
      scope: typeof VOICE_CALL_WRITE_METHOD_SCOPE | typeof VOICE_CALL_READ_METHOD_SCOPE,
    ) => {
      api.registerGatewayMethod(
        method,
        async (options: GatewayRequestHandlerOptions) => {
          try {
            options.respond(true, await handler(options));
          } catch (err) {
            const code =
              err instanceof VoiceCallCommandInputError
                ? ErrorCodes.INVALID_REQUEST
                : ErrorCodes.UNAVAILABLE;
            options.respond(false, undefined, errorShape(code, formatErrorMessage(err)));
          }
        },
        scope,
      );
    };

    registerGatewayCommand(
      "voicecall.initiate",
      async ({ params }) => {
        const message = normalizeOptionalString(params?.message);
        if (!message) {
          throw new VoiceCallCommandInputError("message required");
        }
        return await commands.initiate({
          to: normalizeOptionalString(params?.to),
          message,
          mode:
            params?.mode === "notify" || params?.mode === "conversation" ? params.mode : undefined,
          sessionKey: normalizeOptionalString(params?.sessionKey),
          requesterSessionKey: normalizeOptionalString(params?.requesterSessionKey),
          brief: params?.brief,
        });
      },
      VOICE_CALL_WRITE_METHOD_SCOPE,
    );

    registerGatewayCommand(
      "voicecall.steer",
      ({ params, client, hasCurrentClientAuthority, signal }) => {
        const scopes = client?.connect.scopes ?? [];
        const operator = scopes.includes("operator.write") || scopes.includes("operator.admin");
        if (params.mode !== undefined && params.mode !== "say" && params.mode !== "guidance") {
          throw new VoiceCallCommandInputError("mode must be say or guidance");
        }
        return commands.steer({
          callId: normalizeOptionalString(params.callId),
          message: normalizeOptionalString(params.message),
          mode: params.mode,
          requesterSessionKey: client?.internal?.agentToolCaller?.sessionKey,
          operator,
          assertCurrent: () => {
            signal?.throwIfAborted();
            if (hasCurrentClientAuthority && !hasCurrentClientAuthority()) {
              throw new VoiceCallCommandInputError("Steering caller authority expired");
            }
          },
        });
      },
      VOICE_CALL_WRITE_METHOD_SCOPE,
    );

    registerGatewayCommand(
      "voicecall.continue",
      ({ params }) =>
        commands.continueCall(
          normalizeOptionalString(params?.callId),
          normalizeOptionalString(params?.message),
        ),
      VOICE_CALL_WRITE_METHOD_SCOPE,
    );

    registerGatewayCommand(
      "voicecall.continue.start",
      async ({ params }) =>
        continueOperationStore.start(
          await commands.prepareContinue(
            normalizeOptionalString(params?.callId),
            normalizeOptionalString(params?.message),
          ),
        ),
      VOICE_CALL_WRITE_METHOD_SCOPE,
    );

    registerGatewayCommand(
      "voicecall.continue.result",
      ({ params }) => {
        const operationId = normalizeOptionalString(params?.operationId);
        if (!operationId) {
          throw new VoiceCallCommandInputError("operationId required");
        }
        const operation = continueOperationStore.read(operationId);
        if (!operation.ok) {
          throw new VoiceCallCommandInputError(operation.error);
        }
        return operation.payload;
      },
      VOICE_CALL_READ_METHOD_SCOPE,
    );

    registerGatewayCommand(
      "voicecall.speak",
      ({ params }) =>
        commands.speak({
          callId: normalizeOptionalString(params?.callId),
          message: normalizeOptionalString(params?.message),
          allowTwimlFallback: params?.allowTwimlFallback !== false,
        }),
      VOICE_CALL_WRITE_METHOD_SCOPE,
    );

    registerGatewayCommand(
      "voicecall.dtmf",
      ({ params }) =>
        commands.sendDtmf(
          normalizeOptionalString(params?.callId),
          normalizeOptionalString(params?.digits),
        ),
      VOICE_CALL_WRITE_METHOD_SCOPE,
    );

    registerGatewayCommand(
      "voicecall.end",
      ({ params }) => commands.endCall(normalizeOptionalString(params?.callId)),
      VOICE_CALL_WRITE_METHOD_SCOPE,
    );

    registerGatewayCommand(
      "voicecall.status",
      ({ params }) =>
        commands.status(
          normalizeOptionalString(params?.callId) ?? normalizeOptionalString(params?.sid),
        ),
      VOICE_CALL_READ_METHOD_SCOPE,
    );

    registerGatewayCommand(
      "voicecall.start",
      async ({ params, client }) => {
        const to = normalizeOptionalString(params?.to);
        const requestedAgentId = normalizeOptionalString(params?.agentId);
        const normalizedAgentId = requestedAgentId ? normalizeAgentId(requestedAgentId) : undefined;
        const pluginOwnerId = normalizeOptionalString(client?.internal?.pluginRuntimeOwnerId);
        if (
          requestedAgentId &&
          (!pluginOwnerId || normalizedAgentId !== requestedAgentId.toLowerCase())
        ) {
          throw new VoiceCallCommandInputError(
            "agentId requires a trusted plugin caller and a valid agent id",
          );
        }
        if (!to) {
          throw new VoiceCallCommandInputError("to required");
        }
        return await commands.initiate({
          to,
          message: normalizeOptionalString(params?.message),
          mode:
            params?.mode === "notify" || params?.mode === "conversation" ? params.mode : undefined,
          dtmfSequence: normalizeOptionalString(params?.dtmfSequence),
          sessionKey: normalizeOptionalString(params?.sessionKey),
          requesterSessionKey: normalizeOptionalString(params?.requesterSessionKey),
          brief: params?.brief,
          agentId: normalizedAgentId,
        });
      },
      VOICE_CALL_WRITE_METHOD_SCOPE,
    );

    api.registerTool((toolContext) => {
      const activeCallBinding = asOptionalRecord(toolContext.toolBindings?.voice_call);
      const boundRuntimeRegistration =
        activeCallBinding?.kind === "active-call" ? runtimeCoordinator.current : undefined;
      const boundRuntimeGeneration = boundRuntimeRegistration?.generation;
      const assertActiveCallAuthority = () => {
        if (
          !boundRuntimeRegistration ||
          !boundRuntimeGeneration ||
          runtimeCoordinator.current !== boundRuntimeRegistration ||
          boundRuntimeRegistration.generation !== boundRuntimeGeneration ||
          boundRuntimeGeneration.retired
        ) {
          throw new VoiceCallCommandInputError(
            "The bound realtime call service is no longer active.",
          );
        }
      };
      return {
        name: "voice_call",
        label: "Voice Call",
        description: "Make phone calls and have voice conversations via the voice-call plugin.",
        parameters: VoiceCallToolSchema,
        async execute(_toolCallId, params, signal) {
          const rawParams = asParamRecord(params);
          const requesterSessionKey = normalizeOptionalString(toolContext.sessionKey);
          // Agent ownership and requester lineage come from trusted tool context.
          // Some harnesses omit agentId but retain its canonical session key.
          const contextAgentId =
            normalizeOptionalString(toolContext.agentId) ??
            parseAgentSessionKey(requesterSessionKey)?.agentId;
          const agentId = contextAgentId ? normalizeAgentId(contextAgentId) : undefined;
          try {
            // Preserve tool error precedence: runtime availability is checked before model input.
            const rt = await ensureRuntime();
            const callScope = await resolveActiveVoiceCallToolScope({
              action: rawParams.action,
              binding: toolContext.toolBindings?.voice_call,
              requestedCallId: rawParams.callId,
              runtime: rt,
              assertAuthority: assertActiveCallAuthority,
              signal,
            });
            const initiateParams = {
              to: normalizeOptionalString(rawParams.to),
              message: normalizeOptionalString(rawParams.message),
              dtmfSequence: normalizeOptionalString(rawParams.dtmfSequence),
              sessionKey: normalizeOptionalString(rawParams.sessionKey),
              agentId,
              requesterSessionKey,
              brief: rawParams.brief,
            };
            if (typeof rawParams.action === "string") {
              switch (rawParams.action) {
                case "initiate_call": {
                  const message = initiateParams.message;
                  if (!message) {
                    throw new VoiceCallCommandInputError("message required");
                  }
                  return json(
                    await commands.initiate({
                      ...initiateParams,
                      mode:
                        rawParams.mode === "notify" || rawParams.mode === "conversation"
                          ? rawParams.mode
                          : undefined,
                    }),
                  );
                }
                case "steer_call":
                  if (
                    rawParams.mode !== undefined &&
                    rawParams.mode !== "say" &&
                    rawParams.mode !== "guidance"
                  ) {
                    throw new VoiceCallCommandInputError("mode must be say or guidance");
                  }
                  return json(
                    await commands.steer({
                      callId: normalizeOptionalString(rawParams.callId),
                      message: normalizeOptionalString(rawParams.message),
                      mode: rawParams.mode,
                      requesterSessionKey,
                      assertCurrent: () => signal?.throwIfAborted(),
                    }),
                  );
                case "continue_call":
                  return json(
                    await commands.continueCall(
                      normalizeOptionalString(rawParams.callId),
                      normalizeOptionalString(rawParams.message),
                    ),
                  );
                case "speak_to_user":
                  return json(
                    await commands.speak({
                      callId: normalizeOptionalString(rawParams.callId),
                      message: normalizeOptionalString(rawParams.message),
                    }),
                  );
                case "send_dtmf":
                  return json(
                    await commands.sendDtmf(
                      normalizeOptionalString(rawParams.callId),
                      normalizeOptionalString(rawParams.digits),
                    ),
                  );
                case "end_call":
                  if (!callScope) {
                    signal?.throwIfAborted();
                  }
                  return json(
                    await commands.endCall(
                      callScope?.callId ?? normalizeOptionalString(rawParams.callId),
                      callScope?.execution,
                    ),
                  );
                case "get_status": {
                  const callId = normalizeOptionalString(rawParams.callId);
                  if (!callId) {
                    throw new VoiceCallCommandInputError("callId required");
                  }
                  return json(await commands.status(callId));
                }
              }
            }

            const mode = rawParams.mode ?? "call";
            if (mode === "status") {
              const sid = normalizeOptionalString(rawParams.sid) ?? "";
              if (!sid) {
                throw new Error("sid required for status");
              }
              return json(await commands.status(sid));
            }

            return json(await commands.initiate(initiateParams, "to required for call"));
          } catch (err) {
            return json({
              error: formatErrorMessage(err),
            });
          }
        },
      };
    });

    api.registerCli(
      async ({ program }) => {
        const { registerVoiceCallCli } = await import("./src/cli.js");
        registerVoiceCallCli({
          program,
          config,
          coreConfig: api.config,
          ensureRuntime: () => {
            runtimeRegistration.generation.scheduler = resolvePluginServiceScheduler();
            return ensureRuntime();
          },
          stateRuntime: api.runtime.state,
        });
      },
      { commands: ["voicecall"], descriptors: [VOICE_CALL_CLI_DESCRIPTOR] },
    );

    api.registerService({
      id: "voicecall",
      apiVersion: 2,
      start: (ctx) => {
        if (isCliOnlyProcess()) {
          return;
        }
        try {
          if (runtimeRegistration.generation.retired) {
            if (runtimeCoordinator.current !== runtimeRegistration) {
              throw new VoiceCallRuntimeLifecycleError(
                "Voice call runtime generation was superseded; use the current plugin registration",
              );
            }
            runtimeRegistration.generation = { retired: false };
          }
          runtimeRegistration.generation.scheduler = ctx.scheduler;
          const serviceContext = AsyncLocalStorage.snapshot();
          runtimeRegistration.generation.runInServiceContext = (run) => serviceContext(run);
          runtimeRegistration.generation.serviceHealth = ctx.serviceHealth;
          activateRuntimeGeneration(runtimeRegistration.generation);
        } catch (err) {
          ctx.serviceHealth?.reportFailure(err);
          api.logger.error(`[voice-call] Failed to start runtime: ${formatErrorMessage(err)}`);
          return;
        }
        if (!config.enabled) {
          return;
        }
        if (!validation.valid) {
          const error = new Error(`setup incomplete: ${validation.errors.join("; ")}`);
          ctx.serviceHealth?.reportFailure(error);
          api.logger.error(`[voice-call] Runtime not started: ${error.message}`);
          return;
        }
        void ensureRegisteredRuntime().catch((err: unknown) => {
          if (err instanceof VoiceCallRuntimeLifecycleError) {
            return;
          }
          ctx.serviceHealth?.reportFailure(err);
          api.logger.error(`[voice-call] Failed to start runtime: ${formatErrorMessage(err)}`);
        });
      },
      stop: async () => {
        const runtimeGeneration = runtimeRegistration.generation;
        runtimeGeneration.retired = true;
        try {
          await stopVoiceCallRuntimeGeneration(runtimeCoordinator, runtimeGeneration);
        } finally {
          runtimeGeneration.scheduler = undefined;
          runtimeGeneration.serviceHealth = undefined;
        }
      },
    });
  },
});
