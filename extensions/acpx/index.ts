import { tryDispatchAcpReplyHook } from "openclaw/plugin-sdk/acp-runtime-backend";
import type {
  PluginHookReplyDispatchContext,
  PluginHookReplyDispatchEvent,
} from "openclaw/plugin-sdk/core";
import { createAcpxRuntimeService } from "./register.runtime.js";
import type { OpenClawPluginApi } from "./runtime-api.js";

/**
 * Matches ACP control commands (and related focus commands) that must always
 * be handled by OpenClaw's command router, never swallowed by the ACP runtime.
 *
 * Without this bypass, once an ACP session is active the runtime claims every
 * inbound message via `reply_dispatch`, so commands like `/acp close`,
 * `/acp status`, and `/unfocus` get delivered to the ACP agent as plain text
 * and users have no way to exit ACP from the chat surface.
 *
 * Keeping this regex conservative: only true command-shaped prefixes match
 * (`/acp`, `/acp <action>`, `/focus`, `/focus <arg>`, `/unfocus`). Plain-text
 * turns that merely mention these words are unaffected.
 */
const ACP_CONTROL_COMMAND_RE = /^\/(?:acp|unfocus|focus)(?:\s|$)/i;

function resolveReplyDispatchCandidateText(ctx: PluginHookReplyDispatchEvent["ctx"]): string {
  // Mirror the lookup order used by core's shouldBypassAcpDispatchForCommand
  // so this wrapper classifies the message the same way the command router
  // will see it when dispatch falls through to the default reply path.
  for (const key of ["CommandBody", "BodyForCommands", "RawBody", "Body"] as const) {
    const value = ctx[key];
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return "";
}

function isAcpControlCommand(event: PluginHookReplyDispatchEvent): boolean {
  const candidate = resolveReplyDispatchCandidateText(event.ctx).trim();
  if (!candidate) {
    return false;
  }
  return ACP_CONTROL_COMMAND_RE.test(candidate);
}

/**
 * reply_dispatch wrapper that lets ACP control commands escape the runtime.
 *
 * Returning `undefined` here means we do not claim dispatch, so core falls
 * through to its default reply path, which runs `handleCommands` and matches
 * `/acp ...`, `/unfocus`, `/focus` against their real handlers.
 */
export async function tryDispatchAcpReplyHookWithControlBypass(
  event: PluginHookReplyDispatchEvent,
  ctx: PluginHookReplyDispatchContext,
): ReturnType<typeof tryDispatchAcpReplyHook> {
  if (isAcpControlCommand(event)) {
    return;
  }
  return tryDispatchAcpReplyHook(event, ctx);
}

const plugin = {
  id: "acpx",
  name: "ACPX Runtime",
  description: "Embedded ACP runtime backend with plugin-owned session and transport management.",
  register(api: OpenClawPluginApi) {
    api.registerService(
      createAcpxRuntimeService({
        pluginConfig: api.pluginConfig,
      }),
    );
    api.on("reply_dispatch", tryDispatchAcpReplyHookWithControlBypass);
  },
};

export default plugin;
