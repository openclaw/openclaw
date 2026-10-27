import { createRuntimeConfigReader, selectLiveRuntimeConfig } from "../config/runtime-snapshot.js";
import type { ExecApprovalsFile } from "../infra/exec-approvals-core.js";
import { prepareExecApprovalsCurrentRead } from "../infra/exec-approvals-store.js";
import { loadExecApprovals } from "../infra/exec-approvals.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import type { InternalCodingToolsOptions } from "./agent-tools.options.js";
import type { ResolvedConversationCapabilityProfile } from "./conversation-capability-profile.js";
import { isConversationToolAllowed } from "./conversation-tool-policy-pipeline.js";
import { prepareExecDefaults } from "./exec-defaults.js";
import { isGatewayToolAllowedWithoutAction } from "./gateway-tool-policy.js";
import {
  resolveSandboxRuntimeStatus,
  withSandboxRuntimeStatusInWorker,
} from "./sandbox/runtime-status.js";
import type { projectEffectiveExecPolicy } from "./session-permission-exec-mode.js";
import type { PreparedToolConstruction } from "./tool-construction-preparation.js";

type BrowserLoopbackParams = {
  options?: InternalCodingToolsOptions;
  execApprovals?: ExecApprovalsFile;
  capabilityProfile: ResolvedConversationCapabilityProfile;
  effectiveExecPolicy: ReturnType<typeof projectEffectiveExecPolicy>;
  sandboxed: boolean;
  workspaceOnly: boolean;
  assertConfigCurrent?: () => void;
};

/** Bind the config owner before asynchronous catalog preparation starts. */
export function captureLocalBrowserLoopbackConfig(
  config: InternalCodingToolsOptions["config"],
): () => void {
  const readConfig = config ? createRuntimeConfigReader(config) : () => selectLiveRuntimeConfig();
  const capturedConfig = readConfig();
  return () => {
    if (readConfig() !== capturedConfig) {
      throw new Error(
        "Automatic loopback preview policy changed; retry with the current tool catalog",
      );
    }
  };
}

function canPrepareLocalBrowserLoopback(params: BrowserLoopbackParams): boolean {
  return (
    !params.sandboxed &&
    !params.workspaceOnly &&
    params.options?.config?.browser?.ssrfPolicy === undefined &&
    isConversationToolAllowed(params.capabilityProfile, "exec") &&
    // Native programs have independent authority; Gateway tools honor the deployment ceiling.
    (params.options?.nativeHarnessExecution === true ||
      isGatewayToolAllowedWithoutAction("exec", params.options?.config))
  );
}

/** Browser previews inherit only existing unrestricted execution on this host. */
function prepareLocalBrowserLoopbackPolicy(
  params: BrowserLoopbackParams,
  sandbox?: ReturnType<typeof resolveSandboxRuntimeStatus>,
) {
  if (!canPrepareLocalBrowserLoopback(params) || sandbox?.sandboxed) {
    return undefined;
  }
  const sessionPermissionPolicy = params.options?.sessionPermissionPolicy;
  const preparation = prepareExecDefaults(
    {
      cfg: params.options?.config,
      execApprovals: params.execApprovals,
      agentId: params.capabilityProfile.policy.agentId,
      sessionKey: params.options?.sessionKey,
      sandboxAvailable: false,
      sessionEntry: sessionPermissionPolicy
        ? { permissionMode: sessionPermissionPolicy.mode }
        : undefined,
      execOverrides: params.effectiveExecPolicy,
    },
    sandbox,
  );
  // Empty floors only identify whether host policy could permit this surface.
  // A needs-approvals result never grants access until the current owner is read.
  const possible =
    preparation.kind === "resolved" ? preparation.defaults : preparation.resolve({ version: 1 });
  return possible.effectiveHost === "gateway" &&
    possible.security === "full" &&
    possible.ask === "off"
    ? preparation
    : undefined;
}

/** Capture session/config policy once; only the approval owner is read at effect. */
function createLocalBrowserLoopbackAssertion(
  params: BrowserLoopbackParams,
  readExecApprovals?: () => ExecApprovalsFile,
  preparation = prepareLocalBrowserLoopbackPolicy(params),
): (() => void) | undefined {
  if (!preparation) {
    return undefined;
  }
  const assertConfigCurrent =
    params.assertConfigCurrent ?? captureLocalBrowserLoopbackConfig(params.options?.config);
  assertConfigCurrent();
  const resolve =
    preparation.kind === "resolved"
      ? () => preparation.defaults
      : () =>
          preparation.resolve(readExecApprovals?.() ?? params.execApprovals ?? loadExecApprovals());
  const allowed = () => {
    const current = resolve();
    return current.security === "full" && current.ask === "off";
  };
  if (!allowed()) {
    return undefined;
  }
  return () => {
    params.options?.abortSignal?.throwIfAborted();
    params.options?.assertInvocationCurrent?.();
    // An unrelated config publication also retires this optional grant until
    // the next turn, avoiding a second conversation-policy owner at effect.
    assertConfigCurrent();
    if (!allowed()) {
      throw new Error("Automatic loopback preview requires current unrestricted local execution");
    }
  };
}

/** Optional policy preparation must never disable ordinary browser tools. */
export function createLocalBrowserLoopbackPreparation(params: BrowserLoopbackParams) {
  if (!canPrepareLocalBrowserLoopback(params)) {
    return undefined;
  }
  const pending: {
    assertCurrent: (() => void) | undefined;
    sync(): void;
    prepare(shared: PreparedToolConstruction): Promise<void>;
  } = {
    assertCurrent: undefined,
    sync() {
      try {
        const sandbox = params.options?.sessionKey
          ? resolveSandboxRuntimeStatus({
              cfg: params.options.config,
              agentId: params.capabilityProfile.policy.agentId,
              sessionKey: params.options.sessionKey,
            })
          : undefined;
        const policy = prepareLocalBrowserLoopbackPolicy(params, sandbox);
        if (policy) {
          pending.assertCurrent = createLocalBrowserLoopbackAssertion(
            params,
            loadExecApprovals,
            policy,
          );
        }
      } catch {
        // The deprecated sync factory may not have a prepared sandbox/session owner.
        pending.assertCurrent = undefined;
      }
    },
    async prepare(shared: PreparedToolConstruction) {
      try {
        const prepare = async (sandbox?: ReturnType<typeof resolveSandboxRuntimeStatus>) => {
          const policy = prepareLocalBrowserLoopbackPolicy(params, sandbox);
          if (!policy) {
            return;
          }
          const read =
            policy.kind === "needs-approvals"
              ? await prepareExecApprovalsCurrentRead(
                  captureOpenClawStateWorkerContext({ env: shared.env }),
                )
              : undefined;
          shared.assertCurrent();
          pending.assertCurrent = createLocalBrowserLoopbackAssertion(params, read, policy);
        };
        if (params.options?.sessionKey) {
          await withSandboxRuntimeStatusInWorker(
            {
              cfg: params.options.config,
              agentId: params.capabilityProfile.policy.agentId,
              sessionKey: params.options.sessionKey,
            },
            shared,
            prepare,
          );
        } else {
          await prepare();
        }
      } catch {
        // Missing optional policy authority leaves ordinary tool assembly intact.
        pending.assertCurrent = undefined;
      }
      shared.assertCurrent();
    },
  };
  return pending;
}
