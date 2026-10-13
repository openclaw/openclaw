import {
  isCodexAppServerNativeAuthProfile,
  type CodexAppServerAuthProfileLookup,
} from "./auth-profile.js";
import type { CodexAppServerHomeScope } from "./config-contracts.js";
import {
  CODEX_RESPONSES_OAUTH_PROVIDER,
  isCodexResponsesOAuthCredential,
} from "./responses-oauth.js";
import type { CodexAppServerThreadBinding } from "./session-binding.js";

export const CODEX_NATIVE_PERSONALITY_NONE = "none";

export function resolveCodexBindingModelProviderFallback(params: {
  provider?: string;
  currentModel: string | undefined;
  bindingModel: string | undefined;
  bindingModelProvider: string | undefined;
}): string | undefined {
  const provider = params.provider?.trim().toLowerCase();
  if (provider && provider !== "codex") {
    return undefined;
  }
  const currentModel = params.currentModel?.trim();
  const bindingModel = params.bindingModel?.trim();
  if (
    currentModel &&
    bindingModel &&
    currentModel === bindingModel &&
    params.bindingModelProvider
  ) {
    return params.bindingModelProvider;
  }
  const slashIndex = currentModel?.indexOf("/") ?? -1;
  return slashIndex > 0 && slashIndex < (currentModel?.length ?? 0) - 1
    ? undefined
    : params.bindingModelProvider;
}

export async function resolveCodexAppServerThreadModelSelection(
  params: CodexAppServerAuthProfileLookup & {
    provider: string;
    homeScope?: CodexAppServerHomeScope;
    model: string;
    requestModel?: string;
    inheritBindingAuthProfile?: boolean;
    binding?: Pick<
      CodexAppServerThreadBinding,
      "threadId" | "authProfileId" | "model" | "modelProvider"
    >;
  },
): Promise<{ model: string; modelProvider?: string }> {
  const authProfileId =
    params.inheritBindingAuthProfile === false
      ? params.authProfileId
      : (params.authProfileId ?? params.binding?.authProfileId);
  const explicitModelProvider = await resolveCodexAppServerModelProvider({
    ...params,
    authProfileId,
  });
  const bindingModelProvider = params.binding?.threadId
    ? resolveCodexBindingModelProviderFallback({
        provider: params.provider,
        currentModel: params.model,
        bindingModel: params.binding.model,
        bindingModelProvider: params.binding.modelProvider,
      })
    : undefined;
  return await resolveCodexAppServerRequestModelSelection({
    ...params,
    model: params.requestModel ?? params.model,
    modelProvider: explicitModelProvider ?? bindingModelProvider,
    authProfileId,
  });
}

export async function resolveCodexAppServerRequestModelSelection(
  params: CodexAppServerAuthProfileLookup & {
    model: string;
    homeScope?: CodexAppServerHomeScope;
    modelProvider?: string | null;
  },
): Promise<{ model: string; modelProvider?: string }> {
  const model = params.model.trim();
  const modelProvider = params.modelProvider?.trim();
  if (modelProvider) {
    return { model, modelProvider };
  }
  // Codex app-server expects provider-qualified refs as separate fields. Keep
  // explicit providers intact so provider-owned slashy model ids are not split.
  const slashIndex = model.indexOf("/");
  if (slashIndex <= 0 || slashIndex >= model.length - 1) {
    return { model };
  }
  const inferredProvider = model.slice(0, slashIndex);
  const inferredModelProvider = await resolveCodexAppServerModelProvider({
    ...params,
    provider: inferredProvider,
  });
  return {
    model: model.slice(slashIndex + 1).trim(),
    ...(inferredModelProvider ? { modelProvider: inferredModelProvider } : {}),
  };
}

export async function resolveCodexAppServerModelProvider(
  params: CodexAppServerAuthProfileLookup & {
    provider: string;
    homeScope?: CodexAppServerHomeScope;
  },
): Promise<string | undefined> {
  const normalized = params.provider.trim();
  const normalizedLower = normalized.toLowerCase();
  if (
    normalizedLower === "openai" &&
    params.authProfileId &&
    isCodexResponsesOAuthCredential(params.authProfileStore?.profiles[params.authProfileId])
  ) {
    return CODEX_RESPONSES_OAUTH_PROVIDER;
  }
  if (!normalized || normalizedLower === "codex") {
    // `codex` is OpenClaw's virtual provider; let Codex app-server keep its
    // native provider/auth selection instead of forcing the legacy OpenAI path.
    return undefined;
  }
  if (
    normalizedLower === "openai" &&
    (params.homeScope === "user" || (await isCodexAppServerNativeAuthProfile(params)))
  ) {
    // User-home connections own native auth and provider selection, as do forwarded
    // ChatGPT profiles. Keep that pair together; account/route checks still run
    // at the auth boundary before starting a thread.
    return undefined;
  }
  return normalizedLower === "openai" ? "openai" : normalized;
}
