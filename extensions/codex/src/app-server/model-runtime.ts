import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";

const CODEX_APP_SERVER_RUNTIME_MODEL_PARAM = "codexAppServerRuntimeModel";
const CODEX_APP_SERVER_MULTI_AGENT_VERSION_PARAM = "codexAppServerMultiAgentVersion";

export type CodexMultiAgentVersion = "disabled" | "v1" | "v2";

type CodexRuntimeModel = {
  id: string;
  params?: Record<string, unknown>;
};

export function buildCodexRuntimeModelParams(
  catalogId: string,
  runtimeModelId: string,
  multiAgentVersion?: CodexMultiAgentVersion | null,
) {
  if (catalogId === runtimeModelId && multiAgentVersion == null) {
    return undefined;
  }
  return {
    ...(catalogId !== runtimeModelId
      ? { [CODEX_APP_SERVER_RUNTIME_MODEL_PARAM]: runtimeModelId }
      : {}),
    ...(multiAgentVersion != null
      ? { [CODEX_APP_SERVER_MULTI_AGENT_VERSION_PARAM]: multiAgentVersion }
      : {}),
  };
}

export function readCodexRuntimeModelId(
  model: CodexRuntimeModel | undefined,
  fallbackId: string,
): string {
  return (
    normalizeOptionalString(model?.params?.[CODEX_APP_SERVER_RUNTIME_MODEL_PARAM]) ??
    model?.id ??
    fallbackId
  );
}

export function readCodexModelMultiAgentVersion(
  model: CodexRuntimeModel | undefined,
): CodexMultiAgentVersion | undefined {
  const version = model?.params?.[CODEX_APP_SERVER_MULTI_AGENT_VERSION_PARAM];
  return version === "disabled" || version === "v1" || version === "v2" ? version : undefined;
}
