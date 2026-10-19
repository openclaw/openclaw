import { createHash } from "node:crypto";
import {
  isSessionAccessRefreshingError,
  type GatewayRequestHandlerOptions,
} from "openclaw/plugin-sdk/gateway-runtime";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import {
  executeGoogleResearch,
  parseGoogleResearchInput,
  GoogleResearchError,
  type GoogleResearchHandle,
} from "./research.js";

type InteractionBinding = {
  agentId: string;
  sessionKey: string;
  sessionId: string;
  lifecycleRevision: string | null;
  profileId: string;
  accountIdentity: string;
};
const retentionMs = 7 * 24 * 60 * 60_000;
const bindingKey = (handle: GoogleResearchHandle) =>
  createHash("sha256")
    .update(JSON.stringify([handle.profileId, handle.interactionId]))
    .digest("hex");

export async function handleGoogleResearch(
  api: OpenClawPluginApi,
  options: GatewayRequestHandlerOptions,
) {
  const { params, respond, sessionAccessAuthority: authority } = options;
  let startReturned = false;
  let knownOperation = false;
  let authorityFailure: "retryable" | "blocked" | undefined;
  let receipt: GoogleResearchHandle | undefined;
  try {
    const assertProviderOwner = options.assertHandlerCurrent;
    if (!authority || !assertProviderOwner) {
      throw new Error("Research requires current session and provider authority.");
    }
    const assertProviderCurrent = () => {
      try {
        assertProviderOwner();
      } catch (error) {
        authorityFailure = "retryable";
        throw error;
      }
    };
    const assertCurrent = () => {
      assertProviderCurrent();
      try {
        authority.assertCurrent();
      } catch (error) {
        authorityFailure = isSessionAccessRefreshingError(error) ? "retryable" : "blocked";
        throw error;
      }
    };
    const target = {
      ...authority.target,
      lifecycleRevision: authority.target.lifecycleRevision ?? null,
    };
    const config = api.pluginConfig?.research;
    if (
      !config ||
      typeof config !== "object" ||
      Array.isArray(config) ||
      !("enabled" in config) ||
      config.enabled !== true ||
      !("profileId" in config) ||
      typeof config.profileId !== "string" ||
      !config.profileId.trim()
    ) {
      throw new Error("Google managed research is not explicitly enabled with an API-key profile.");
    }
    const profileId = config.profileId;
    const request = params.request;
    if (
      !request ||
      typeof request !== "object" ||
      !("version" in request) ||
      request.version !== 1
    ) {
      throw new Error("Invalid versioned research request.");
    }
    const { version: _version, ...body } = request;
    if ("profileId" in body) {
      throw new Error("Research profile selection is provider-owned.");
    }
    const input = parseGoogleResearchInput(
      "action" in body && body.action === "start" ? { ...body, profileId } : body,
    );
    if (input.action === "poll" || input.action === "cancel") {
      knownOperation = true;
      receipt = input.handle;
    }
    assertCurrent();

    if (
      (input.action === "poll" || input.action === "cancel") &&
      input.handle.profileId !== profileId
    ) {
      throw new Error(
        "Research credential owner changed; the recorded job cannot switch profiles.",
      );
    }
    const bindings = api.runtime.state.openKeyedStoreV2<InteractionBinding>(
      { namespace: "research-interactions-v1", maxEntries: 4096, overflowPolicy: "reject-new" },
      { assertCurrent: assertProviderCurrent },
    );
    let binding: InteractionBinding | undefined;
    if (input.action === "poll" || input.action === "cancel") {
      binding = await bindings.lookup(bindingKey(input.handle));
      assertCurrent();
      if (
        !binding ||
        binding.agentId !== target.agentId ||
        binding.sessionKey !== target.sessionKey ||
        binding.sessionId !== target.sessionId ||
        binding.lifecycleRevision !== target.lifecycleRevision ||
        binding.profileId !== profileId
      ) {
        throw new Error("Research interaction is not owned by this conversation generation.");
      }
    }
    const value = await executeGoogleResearch(input, {
      api,
      agentId: authority.target.agentId,
      signal: options.signal ?? AbortSignal.timeout(60_000),
      assertCurrent,
      prepareAccount: async (accountIdentity) => {
        assertCurrent();
        if (binding) {
          if (binding.accountIdentity !== accountIdentity) {
            throw new Error("Research credential account changed.");
          }
        } else {
          if ((await bindings.count()) >= 4096) {
            throw new Error("Research interaction capacity reached.");
          }
          assertCurrent();
          binding = {
            ...target,
            profileId,
            accountIdentity,
          };
        }
      },
      recordReceipt: async (handle) => {
        receipt = handle;
        startReturned = input.action === "start";
        // This is custody of an already-returned receipt, not another provider
        // effect or report delivery. Preserve its original binding even when
        // the source borrow closed; the live provider owner still fences writes.
        assertProviderCurrent();
        if (input.action === "start") {
          if (
            !binding ||
            !(await bindings.registerIfAbsent(bindingKey(handle), binding, {
              ttlMs: retentionMs,
            }))
          ) {
            throw new Error("Research interaction binding was not recorded.");
          }
          assertProviderCurrent();
        }
      },
    });
    startReturned = input.action === "start";
    if ("handle" in value) {
      receipt = value.handle;
    }
    assertCurrent();
    const reply = { version: 1, ok: true, value };
    respond(true, reply);
  } catch (error) {
    // The host state store checks its runtime owner before our supplied guard.
    // Recheck that owner for classification when an awaited lookup failed first;
    // this cannot grant authority or turn a permanent source refusal into a retry.
    if (!authorityFailure) {
      try {
        options.assertHandlerCurrent?.();
      } catch {
        authorityFailure = "retryable";
      }
    }
    const reply =
      knownOperation && authorityFailure
        ? {
            version: 1,
            ok: false,
            state: authorityFailure === "retryable" ? "indeterminate" : "blocked",
            ...(authorityFailure === "retryable" ? { retryAfterMs: 5000 } : {}),
            ...(receipt ? { handle: receipt } : {}),
            reason: "Google research reconciliation requires fresh provider or session authority.",
          }
        : error instanceof GoogleResearchError
          ? {
              version: 1,
              ok: false,
              state: error.state,
              reason: error.message,
              ...(error.handle ? { handle: error.handle } : {}),
              ...(error.state === "blocked" && authorityFailure === "retryable"
                ? { retryAfterMs: 5000 }
                : error.retryAfterMs === undefined
                  ? {}
                  : { retryAfterMs: error.retryAfterMs }),
            }
          : {
              version: 1,
              ok: false,
              state: startReturned ? "indeterminate" : "blocked",
              ...(!startReturned && authorityFailure === "retryable" ? { retryAfterMs: 5000 } : {}),
              // A handle is not authority. Preserve a known receipt without publishing
              // report content; every reconciliation must pass fresh host/profile fences.
              ...(receipt ? { handle: receipt } : {}),
              reason: startReturned
                ? "Google research returned a submission, but authority changed before delivery. Do not repeat the start request."
                : "Google research is unavailable under the current configuration or session authority.",
            };
    respond(true, reply);
  }
}
