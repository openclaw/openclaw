import type { AgentHarnessRuntimeArtifactBinding } from "openclaw/plugin-sdk/agent-harness-runtime";
import type { CodexAppServerClient } from "./client.js";
import type { CodexAppServerRuntimeOptions } from "./config.js";
import type { CodexSandboxPolicy, CodexTurnEnvironmentParams } from "./protocol.js";
import type { CodexSandboxExecEnvironment } from "./sandbox-exec-server.js";
import type { CodexAppServerThreadLifecycleBinding } from "./thread-lifecycle.js";
import type { CodexAppServerTurnRouter, CodexThreadRouteReservation } from "./turn-router.js";

export type StartCodexAttemptThreadResult = {
  client: CodexAppServerClient;
  turnRouter: CodexAppServerTurnRouter;
  turnRoute: CodexThreadRouteReservation;
  thread: CodexAppServerThreadLifecycleBinding;
  pluginAppServer: CodexAppServerRuntimeOptions;
  sandboxEnvironment: CodexSandboxExecEnvironment | undefined;
  environmentSelection: CodexTurnEnvironmentParams[] | undefined;
  executionCwd: string;
  sandboxPolicy: CodexSandboxPolicy | undefined;
  runtimeArtifact?: AgentHarnessRuntimeArtifactBinding;
  releaseSharedClientLease: () => void;
  restartContextEngineCodexThread: () => Promise<CodexAppServerThreadLifecycleBinding>;
};
