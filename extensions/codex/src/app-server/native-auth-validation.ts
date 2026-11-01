import type { CodexAppServerAuthRequirement } from "./auth-types.js";
import type { CodexAppServerClient } from "./client.js";
import { readProviderField } from "./inference-provider-config.js";
import { isJsonObject, type CodexGetAccountResponse, type JsonObject } from "./protocol.js";

/** Bind the host-selected route; Codex owns native credential composition and validation. */
export function assertCodexNativeCommandAuthConfig(params: {
  provider: string;
  baseUrl: string | undefined;
  effectiveConfig: JsonObject;
  threadConfig?: JsonObject;
}): void {
  const field = (name: string) =>
    readProviderField(params.threadConfig, params.provider, name) ??
    readProviderField(params.effectiveConfig, params.provider, name);
  const auth = field("auth");
  if (
    !params.baseUrl ||
    field("base_url") !== params.baseUrl ||
    field("wire_api") !== "responses" ||
    !isJsonObject(auth) ||
    typeof auth.command !== "string" ||
    !auth.command.trim()
  ) {
    throw new Error(
      "Native command auth requires a matching Codex model_providers entry with command auth and the same HTTPS Responses endpoint.",
    );
  }
}

/**
 * Native-home connections are verified, never logged into. Both directions of the
 * check protect the same billing boundary: a subscription route cannot run without
 * ChatGPT tokens, and a Platform route must not silently spend the operator's
 * ChatGPT plan. An absent account is left alone because the native home may serve a
 * custom model provider that reports no OpenAI account at all.
 */
export async function assertNativeCodexAccountMatchesRoute(
  client: CodexAppServerClient,
  authRequirement: CodexAppServerAuthRequirement | undefined,
  assertCurrent?: () => void,
  withCurrent?: (write: () => void) => Promise<void>,
): Promise<void> {
  if (!authRequirement || authRequirement === "native-command") {
    return;
  }
  const response = await client.request<CodexGetAccountResponse>(
    "account/read",
    { refreshToken: false },
    { assertCurrent, withCurrent },
  );
  const accountType = response.account?.type;
  if (authRequirement === "subscription") {
    if (accountType !== "chatgpt") {
      throw createCodexAppServerAuthError(
        'Codex subscription route requires ChatGPT auth in the native Codex home. Run `codex login` for that home, or use appServer.homeScope="agent" with an OpenClaw OAuth profile, then retry.',
      );
    }
    return;
  }
  if (accountType === "chatgpt") {
    throw createCodexAppServerAuthError(
      'Codex Platform route requires an API-key account, but the native Codex home is signed in with a ChatGPT subscription. Sign that home in with `codex login --with-api-key`, or set appServer.homeScope="agent" so OpenClaw can inject its own key.',
    );
  }
}

export function createCodexAppServerAuthError(message: string): Error & { status: 401 } {
  return Object.assign(new Error(message), { status: 401 as const });
}
