import type { AgentHarnessRuntimeArtifactBinding } from "openclaw/plugin-sdk/agent-harness-runtime";
import type { AuthProfileStore } from "openclaw/plugin-sdk/provider-auth";
import type { resolveCodexAppServerAuthProfileIdForAgent } from "./auth-profile.js";
import type * as codexAuth from "./auth-types.js";
import type { CodexAppServerClient } from "./client.js";
import type { CodexAppServerStartOptions } from "./config-contracts.js";
import type { CodexAppServerAcquireObservation } from "./shared-client-lifecycle.js";

export type CodexAppServerClientOptions = {
  startOptions?: CodexAppServerStartOptions;
  pluginConfig?: unknown;
  timeoutMs?: number;
  authProfileId?: string | null;
  authProfileStore?: AuthProfileStore;
  authBindingFingerprint?: string;
  /** Setup-only generation whose exact local runtime bytes are captured. */
  runtimeArtifactMode?: "capture";
  /** Previously minted exact runtime required before the process may start. */
  expectedRuntimeArtifact?: AgentHarnessRuntimeArtifactBinding;
  preparedAuth?: codexAuth.CodexAppServerPreparedAuth;
  authRequirement?: codexAuth.CodexAppServerAuthRequirement;
  agentId?: string;
  agentDir?: string;
  config?: Parameters<typeof resolveCodexAppServerAuthProfileIdForAgent>[0]["config"];
  onStartedClient?: (client: CodexAppServerClient) => void;
  onAcquireObservation?: (observation: CodexAppServerAcquireObservation) => void;
  abandonSignal?: AbortSignal;
  /** Caller authority for startup of an isolated, caller-owned client. */
  assertCurrent?: () => void;
  /** Caller row authority, awaited immediately before isolated startup effects. */
  assertCurrentAsync?: () => Promise<void>;
};
