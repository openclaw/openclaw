// Codex helper module selects an app-server connection from private binding ownership.
import { AgentHarnessPreflightError } from "openclaw/plugin-sdk/agent-harness-registration";
import type { EmbeddedRunAttemptParamsV2 } from "openclaw/plugin-sdk/agent-harness-runtime";
import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";
import type { CodexCatalogHome } from "../session-catalog-types.js";
import type { CodexAppServerRuntimeOptions } from "./config-contracts.js";
import type { resolveCodexAppServerRuntimeOptions } from "./config-runtime.js";
import type { CodexAppServerThreadBinding } from "./session-binding.js";

export type CodexCatalogHomeDiscovery = (agentDir: string) => Promise<readonly CodexCatalogHome[]>;

const catalogHomes = createPluginRuntimeStore<CodexCatalogHomeDiscovery>({
  key: "codex:catalog-home-resolver",
  errorMessage: "Codex catalog homes are unavailable",
});
export const setCodexCatalogConnectionHomeResolver = catalogHomes.setRuntime;

type CodexAppServerRuntimeOptionsParams = NonNullable<
  Parameters<typeof resolveCodexAppServerRuntimeOptions>[0]
>;

export type CodexBindingAppServerConnection = {
  appServer: CodexAppServerRuntimeOptions;
  usesSupervisionConnection: boolean;
  requestAuthProfileId: string | undefined;
  clientAuthProfileId: string | null | undefined;
};

type CodexSupervisionModelSelection = {
  model: string;
  modelProvider: string;
};

/** Connection selection excludes independently updated thread bookkeeping. */
export function codexBindingConnectionSelection(binding: CodexAppServerThreadBinding | undefined) {
  return binding
    ? ([
        binding.threadId,
        binding.cwd.trim(),
        binding.connectionScope,
        binding.pendingSupervisionBranch?.connectionFingerprint ??
          binding.appServerRuntimeFingerprint,
        binding.authProfileId,
        binding.preserveNativeModel === true,
      ] as const)
    : undefined;
}

/** Prevents a prepared native session from becoming a fresh thread after its binding changes. */
export function assertCodexSessionRuntimeOwnership(
  binding:
    | Pick<
        CodexAppServerThreadBinding,
        "preserveNativeModel" | "connectionScope" | "model" | "modelProvider"
      >
    | undefined,
  expected: EmbeddedRunAttemptParamsV2["expectedSessionRuntimeOwnership"],
): void {
  if (!expected) {
    return;
  }
  const auth = binding?.connectionScope === "supervision" ? "native" : "host";
  const hostModelChanged =
    expected.auth === "host" &&
    (!expected.modelRef ||
      binding?.model !== expected.modelRef.model ||
      binding?.modelProvider !== expected.modelRef.provider);
  if (binding?.preserveNativeModel !== true || auth !== expected.auth || hostModelChanged) {
    throw new AgentHarnessPreflightError(
      "Codex native session ownership is missing or changed. Reattach the original native session or create a new chat with a concrete model; no replacement thread was started.",
    );
  }
}

/** Requires the native model pair after a supervised pending branch has materialized. */
export function requireCodexSupervisionModelSelection(
  binding: Pick<CodexAppServerThreadBinding, "connectionScope" | "model" | "modelProvider">,
): CodexSupervisionModelSelection {
  const model = binding.model?.trim();
  const modelProvider = binding.modelProvider?.trim();
  if (binding.connectionScope !== "supervision" || !model || !modelProvider) {
    throw new Error(
      "Codex supervised binding is missing its native model and provider; refusing request selection",
    );
  }
  return { model, modelProvider };
}

export type CodexBindingAppServerConnectionParams = CodexAppServerRuntimeOptionsParams & {
  binding?: Pick<
    CodexAppServerThreadBinding,
    "appServerRuntimeFingerprint" | "connectionScope" | "pendingSupervisionBranch"
  >;
  authProfileId?: string;
  assertCurrent?: () => void;
};

/** Registration publishes the resolver; connection policy loads only for an actual request. */
export async function resolveCodexBindingAppServerConnection(
  params: CodexBindingAppServerConnectionParams,
): Promise<CodexBindingAppServerConnection> {
  const runtime = await import("./binding-connection.runtime.js");
  return runtime.resolveCodexBindingAppServerConnection(params, catalogHomes.tryGetRuntime());
}
