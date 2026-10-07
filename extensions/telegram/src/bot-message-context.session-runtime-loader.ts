import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { TelegramMessageContextSessionRuntimeOverrides } from "./bot-message-context.types.js";

type TelegramMessageContextSessionRuntime =
  typeof import("./bot-message-context.session.runtime.js");

const sessionRuntimeMethods = [
  "buildChannelInboundEventContext",
  "readAmbientTranscriptWatermark",
  "readSessionUpdatedAtAsync",
  "recordInboundSession",
  "resolveAmbientTranscriptWatermarkKey",
  "resolveInboundLastRouteSessionKey",
  "resolvePinnedMainDmOwnerFromAllowlist",
  "resolveStorePath",
] as const satisfies readonly (keyof TelegramMessageContextSessionRuntime)[];

function hasCompleteSessionRuntime(
  runtime: TelegramMessageContextSessionRuntimeOverrides | undefined,
): runtime is TelegramMessageContextSessionRuntime {
  return Boolean(
    runtime && sessionRuntimeMethods.every((method) => typeof runtime[method] === "function"),
  );
}

export async function loadTelegramMessageContextSessionRuntime(
  runtime: TelegramMessageContextSessionRuntimeOverrides | undefined,
): Promise<TelegramMessageContextSessionRuntime> {
  if (hasCompleteSessionRuntime(runtime)) {
    return runtime;
  }
  return {
    ...(await import("./bot-message-context.session.runtime.js")),
    ...runtime,
  };
}

export async function resolveTelegramMessageContextStorePath(params: {
  cfg: OpenClawConfig;
  agentId: string;
  sessionRuntime?: TelegramMessageContextSessionRuntimeOverrides;
}): Promise<string> {
  const sessionRuntime = await loadTelegramMessageContextSessionRuntime(params.sessionRuntime);
  return sessionRuntime.resolveStorePath(params.cfg.session?.store, {
    agentId: params.agentId,
  });
}
