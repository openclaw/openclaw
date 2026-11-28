import {
  getModelProviderRequestTransport,
  type AgentHarnessCompactParams,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { AttemptParamsLike, ModelRefInputObject } from "./attempt-types.js";
import { createCopilotByokAuth, resolveCopilotAuth, tokenFingerprint } from "./auth-bridge.js";
import { resolveCopilotSessionModel } from "./model-selection.js";
import { resolveCopilotProvider } from "./provider-bridge.js";

type CopilotCompactParamsLike = Omit<AgentHarnessCompactParams, "model"> &
  Pick<AttemptParamsLike, "auth" | "copilotHome" | "profileVersion"> & {
    model?: string | ModelRefInputObject;
    modelId?: string;
  };

type CopilotSessionCompatInput =
  | { kind: "attempt"; params: AttemptParamsLike }
  | { kind: "compact"; params: CopilotCompactParamsLike };

function readAgentIdFromSessionKey(sessionKey: unknown): string | undefined {
  if (typeof sessionKey !== "string") {
    return undefined;
  }
  const parts = sessionKey.trim().split(":");
  return parts[0] === "agent" && parts[1]?.trim() ? parts[1].trim() : undefined;
}

function computeSessionKey(
  input: CopilotSessionCompatInput,
  options: { includeApi: boolean; includeAuth: boolean },
): string {
  // Match the pool's effective auth resolution; hash tokens so rotation invalidates
  // replay without retaining the credential itself.
  const attempt = input.kind === "attempt" ? input.params : undefined;
  const compact = input.kind === "compact" ? input.params : undefined;
  const attemptModel = attempt?.model;
  const compactModel = compact?.model;
  const rawModel: string | ModelRefInputObject | undefined = attemptModel ?? compactModel;
  const modelObj: ModelRefInputObject =
    rawModel && typeof rawModel === "object"
      ? rawModel
      : (compact?.runtimeModel ?? {
          id: typeof rawModel === "string" ? rawModel : undefined,
        });
  const provider =
    normalizeOptionalString(modelObj.provider) ?? attempt?.provider ?? compact?.provider ?? "";
  const modelId =
    normalizeOptionalString(modelObj.id) ??
    attempt?.modelId ??
    compact?.modelId ??
    (typeof compactModel === "string" ? compactModel : "");
  const requestTransport =
    rawModel && typeof rawModel === "object"
      ? getModelProviderRequestTransport(rawModel)
      : undefined;
  const requestAuthMode = normalizeOptionalString(
    requestTransport?.auth?.mode ?? modelObj.request?.auth?.mode,
  );
  const azureApiVersion = normalizeOptionalString(
    modelObj.azureApiVersion ?? modelObj.params?.azureApiVersion,
  );
  // Invalid explicit auth fails in resolvePoolAcquire; keep its fingerprint
  // deterministic here without allowing it to match a valid session.
  let authParts: string[];
  let resolvedAgentId = "";
  let resolvedCopilotHome = "";
  try {
    const authContext = {
      agentId: input.params.agentId ?? readAgentIdFromSessionKey(input.params.sessionKey),
      agentDir: input.params.agentDir,
      copilotHome: input.params.copilotHome,
    };
    const resolved = !options.includeAuth
      ? resolveCopilotAuth({
          ...authContext,
          auth: { useLoggedInUser: true },
        })
      : (() => {
          const modelProvider = resolveCopilotProvider({
            model: {
              api: normalizeOptionalString(modelObj.api),
              id: modelId,
              provider,
              baseUrl: normalizeOptionalString(modelObj.baseUrl),
              azureApiVersion,
              headers: modelObj.headers,
              authHeader: modelObj.authHeader,
              requestAuthMode,
              requestProxy: requestTransport?.proxy ?? modelObj.request?.proxy,
              requestTls: requestTransport?.tls ?? modelObj.request?.tls,
              requestAllowPrivateNetwork:
                requestTransport?.allowPrivateNetwork ?? modelObj.request?.allowPrivateNetwork,
              contextTokens: modelObj.contextTokens,
              contextWindow: modelObj.contextWindow,
              maxTokens: modelObj.maxTokens,
            },
            resolvedApiKey: input.params.resolvedApiKey,
            authProfileId: input.params.authProfileId,
          });
          return modelProvider.mode === "byok"
            ? createCopilotByokAuth({
                ...authContext,
                authProfileId: modelProvider.authProfileId,
                authProfileVersion: modelProvider.authProfileVersion,
              })
            : resolveCopilotAuth({
                ...authContext,
                auth: input.params.auth,
                resolvedApiKey: input.params.resolvedApiKey,
                authProfileId: input.params.authProfileId,
                profileVersion: input.params.profileVersion,
              });
        })();
    resolvedAgentId = resolved.agentId;
    resolvedCopilotHome = resolved.copilotHome;
    authParts = [
      `auth.mode=${resolved.authMode}`,
      `auth.profileId=${resolved.authProfileId ?? ""}`,
      `auth.profileVersion=${resolved.authProfileVersion ?? ""}`,
    ];
  } catch {
    authParts = ["auth=unresolvable"];
  }
  const { capi } = resolveCopilotSessionModel(
    { id: modelId, provider, params: modelObj.params },
    input.params,
  );
  const parts = [
    `provider=${provider}`,
    `model=${modelId}`,
    ...(capi?.fusionTier ? [`fusionTier=${capi.fusionTier}`] : []),
    ...(options.includeApi ? [`api=${normalizeOptionalString(modelObj.api) ?? ""}`] : []),
    ...(options.includeApi
      ? [`baseUrlFingerprint=${fingerprintSessionValue(modelObj.baseUrl)}`]
      : []),
    `cwd=${input.params.cwd ?? input.params.workspaceDir ?? ""}`,
    `agentId=${resolvedAgentId}`,
    `agentDir=${input.params.agentDir ?? ""}`,
    `copilotHome=${input.params.copilotHome ?? ""}`,
    `resolvedCopilotHome=${resolvedCopilotHome}`,
    ...(options.includeAuth ? authParts : []),
  ];
  return parts.join("|");
}

function fingerprintSessionValue(value: unknown): string {
  return typeof value === "string" && value ? tokenFingerprint(value) : "";
}

export function computeSessionCompatKey(params: AttemptParamsLike): string {
  return computeSessionKey({ kind: "attempt", params }, { includeApi: true, includeAuth: true });
}

export function computeAttemptCompactKey(params: AttemptParamsLike): string {
  return computeSessionKey({ kind: "attempt", params }, { includeApi: false, includeAuth: false });
}

export function computeCompactRequestKey(params: CopilotCompactParamsLike): string {
  return computeSessionKey({ kind: "compact", params }, { includeApi: false, includeAuth: false });
}
