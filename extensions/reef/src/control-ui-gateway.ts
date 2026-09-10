import type { OpenClawPluginApi } from "openclaw/plugin-sdk/channel-entry-contract";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import {
  ErrorCodes,
  errorShape,
  type GatewayRequestHandlerOptions,
} from "openclaw/plugin-sdk/gateway-runtime";
import { z } from "zod";
import { handleReefCommandWords } from "./commands.js";
import { resolveReefConfig, type ReefCoreConfig } from "./config-schema.js";
import { getActiveReef } from "./runtime.js";

const emptyParams = z.strictObject({});
const peerSchema = z
  .string()
  .trim()
  .regex(/^@?[a-z0-9][a-z0-9_-]{0,62}$/i);
const peerParams = z.strictObject({ peer: peerSchema });
const friendRequestParams = peerParams.extend({
  code: z.string().trim().min(1).max(256).optional(),
});
const shareParams = peerParams.extend({ sessionKey: z.string().trim().min(1).max(256) });
const mountParams = z.strictObject({ mountId: z.string().trim().min(1).max(256) });
const promptParams = mountParams.extend({ text: z.string().trim().min(1).max(20_000) });

function respondError(respond: GatewayRequestHandlerOptions["respond"], error: unknown): void {
  const message = formatErrorMessage(error);
  respond(
    false,
    undefined,
    errorShape(
      error instanceof z.ZodError ? ErrorCodes.INVALID_REQUEST : ErrorCodes.UNAVAILABLE,
      message,
    ),
  );
}

function register(
  api: OpenClawPluginApi,
  method: string,
  scope: "operator.read" | "operator.admin",
  run: (params: unknown) => Promise<unknown>,
): void {
  api.registerGatewayMethod(
    method,
    async ({ params, respond }) => {
      try {
        respond(true, await run(params ?? {}));
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope },
  );
}

async function runOwnerCommand(words: string[]): Promise<{ message: string }> {
  const result = await handleReefCommandWords({ words, senderIsOwner: true });
  return { message: result.text };
}

/** Register the operator-only Reef methods consumed by its native Control UI. */
export function registerReefControlUiGatewayMethods(api: OpenClawPluginApi): void {
  register(api, "reef.controlUi.status", "operator.read", async (params) => {
    emptyParams.parse(params);
    // SAFETY: the host runtime returns the active OpenClaw config; Reef reads only its optional channel subtree.
    const config = resolveReefConfig(api.runtime.config.current() as ReefCoreConfig);
    const configured = Boolean(config.handle && config.email && config.guard);
    let active: ReturnType<typeof getActiveReef>;
    try {
      active = getActiveReef();
    } catch (error) {
      return {
        enabled: config.enabled,
        configured,
        running: false,
        handle: config.handle ?? null,
        relayUrl: config.relayUrl,
        unavailableReason: formatErrorMessage(error),
        friends: [],
        mounts: [],
        proposals: [],
      };
    }
    const friends = await active.friends.list();
    return {
      enabled: config.enabled,
      configured,
      running: true,
      handle: config.handle ?? null,
      relayUrl: config.relayUrl,
      friends: friends.map((friend) => ({
        peer: friend.peer,
        status: friend.status,
        autonomy: friend.autonomy ?? null,
        fingerprint: friend.fingerprint,
      })),
      mounts: active.federation.listMounts().map((mount) => ({
        mountId: mount.mountId,
        peer: mount.peer,
        role: mount.role,
        sessionKey: mount.sessionKey,
        grantGeneration: mount.grantGeneration,
        allowAlways: mount.allowAlways,
        revoked: mount.revoked,
        revocationPending: mount.revocationPending ?? false,
      })),
      proposals: [
        ...active.federation.listPromptProposals().map((proposal) => ({
          direction: "inbound" as const,
          proposalId: proposal.proposalId,
          mountId: proposal.mountId,
          peer: proposal.request.peer,
          text: proposal.request.frame.text,
          status: proposal.status,
          approvalId: proposal.approvalId ?? null,
          outcome: proposal.outcome?.type ?? null,
          reason: proposal.outcome && "reason" in proposal.outcome ? proposal.outcome.reason : null,
          message:
            proposal.outcome && "message" in proposal.outcome ? proposal.outcome.message : null,
        })),
        ...active.federation.listOutboundPromptProposals().map((proposal) => ({
          direction: "outbound" as const,
          proposalId: proposal.frame.proposalId,
          mountId: proposal.frame.mountId,
          peer: proposal.peer,
          text: proposal.frame.text,
          status: proposal.outcome
            ? proposal.outcome.type === "session.prompt.accepted"
              ? "accepted"
              : proposal.outcome.type === "session.prompt.denied"
                ? "denied"
                : "failed"
            : "pending",
          approvalId: null,
          outcome: proposal.outcome?.type ?? null,
          reason: proposal.outcome && "reason" in proposal.outcome ? proposal.outcome.reason : null,
          message:
            proposal.outcome && "message" in proposal.outcome ? proposal.outcome.message : null,
        })),
      ],
    };
  });

  register(api, "reef.controlUi.friendCode", "operator.admin", async (params) => {
    emptyParams.parse(params);
    return await runOwnerCommand(["friend", "code"]);
  });
  register(api, "reef.controlUi.friendRequest", "operator.admin", async (params) => {
    const { peer, code } = friendRequestParams.parse(params);
    return await runOwnerCommand(["friend", "request", peer, ...(code ? [code] : [])]);
  });
  register(api, "reef.controlUi.friendRemove", "operator.admin", async (params) => {
    const { peer } = peerParams.parse(params);
    return await runOwnerCommand(["friend", "remove", peer]);
  });
  register(api, "reef.controlUi.sessionShare", "operator.admin", async (params) => {
    const { peer, sessionKey } = shareParams.parse(params);
    return await runOwnerCommand(["session", "share", peer, sessionKey]);
  });
  register(api, "reef.controlUi.sessionRevoke", "operator.admin", async (params) => {
    const { mountId } = mountParams.parse(params);
    return await runOwnerCommand(["session", "revoke", mountId]);
  });
  register(api, "reef.controlUi.sessionPrompt", "operator.admin", async (params) => {
    const { mountId, text } = promptParams.parse(params);
    return await runOwnerCommand(["session", "prompt", mountId, text]);
  });
}
