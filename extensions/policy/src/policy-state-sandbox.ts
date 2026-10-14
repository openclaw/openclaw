import { splitSandboxBindSpec } from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  asNonArrayRecord,
  asBoolean as readBoolean,
  normalizeOptionalString as readString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  collectPolicyAgentContexts,
  resolvePolicyValue,
  type PolicyAgentContext,
} from "./policy-state-helpers.js";
import { readStringArray } from "./policy-state-tool-posture.js";
import type { PolicySandboxPostureEvidence } from "./policy-state-types.js";

// Mirrors the sandbox browser config default without importing core internals into the policy plugin.
const DEFAULT_POLICY_SANDBOX_BROWSER_NETWORK = "openclaw-sandbox-browser";

export function scanPolicySandboxPosture(
  cfg: Record<string, unknown>,
): readonly PolicySandboxPostureEvidence[] {
  const entries: PolicySandboxPostureEvidence[] = [];
  for (const context of collectPolicyAgentContexts(cfg, "defaults")) {
    pushSandboxPostureEvidence(entries, {
      ...context,
      sharedSandboxScope:
        context.scope === "agent" &&
        (readString(context.sandbox.scope) ?? readString(context.inheritedSandbox.scope)) ===
          "shared",
      sourceBase: `${context.workspaceSourceBase}/sandbox`,
    });
  }

  return entries.toSorted((a, b) => a.source.localeCompare(b.source) || a.id.localeCompare(b.id));
}

type SandboxPostureParams = PolicyAgentContext<"defaults"> & {
  readonly effectiveBackend?: string;
  readonly sharedSandboxScope?: boolean;
  readonly sourceBase: string;
};

function pushSandboxPostureEvidence(
  entries: PolicySandboxPostureEvidence[],
  params: SandboxPostureParams,
): void {
  pushSandboxPostureValue(entries, params, {
    suffix: "mode",
    kind: "mode",
    ...resolvePolicyValue(
      readString(params.sandbox.mode),
      readString(params.inheritedSandbox.mode),
      "off",
    ),
  });

  const backend = resolvePolicyValue(
    readString(params.sandbox.backend),
    readString(params.inheritedSandbox.backend),
    "docker",
  );
  const effectiveBackend = backend.value.toLowerCase();
  const effectiveParams = { ...params, effectiveBackend };
  pushSandboxPostureValue(entries, params, {
    suffix: "backend",
    kind: "backend",
    ...backend,
    value: effectiveBackend,
  });

  if (effectiveBackend === "docker" || effectiveBackend === "podman") {
    pushSandboxDockerPosture(entries, effectiveParams);
  }
  pushSandboxBrowserPosture(entries, effectiveParams);
}

function pushSandboxDockerPosture(
  entries: PolicySandboxPostureEvidence[],
  params: SandboxPostureParams,
): void {
  const localDocker = !params.sharedSandboxScope ? asNonArrayRecord(params.sandbox.docker) : {};
  const inheritedDocker = asNonArrayRecord(params.inheritedSandbox.docker);
  pushSandboxPostureValue(entries, params, {
    suffix: "docker/network",
    kind: "containerNetwork",
    ...resolvePolicyValue(
      readString(localDocker.network),
      readString(inheritedDocker.network),
      "none",
    ),
    networkSurface: "docker",
  });

  for (const profile of ["seccomp", "apparmor"] as const) {
    const key = `${profile}Profile`;
    const localValue = readString(localDocker[key]);
    const inheritedValue = readString(inheritedDocker[key]);
    const inherited = localValue === undefined && inheritedValue !== undefined;
    const value = localValue ?? inheritedValue;
    pushSandboxPostureValue(entries, params, {
      suffix: `docker/${profile}/profile`,
      sourceSuffix: `docker/${key}`,
      kind: "containerSecurityProfile",
      inherited,
      profile,
      value,
      explicit: value !== undefined,
    });
  }
  pushSandboxBindPosture(entries, params, "docker");
}

function pushSandboxBindPosture(
  entries: PolicySandboxPostureEvidence[],
  params: SandboxPostureParams,
  surface: "browser" | "docker",
  configSurface = surface,
): void {
  const local = !params.sharedSandboxScope ? asNonArrayRecord(params.sandbox[configSurface]) : {};
  const inheritedConfig = asNonArrayRecord(params.inheritedSandbox[configSurface]);
  const inheritedBinds = readStringArray(inheritedConfig.binds);
  const localBinds = readStringArray(local.binds);
  for (const [index, bind] of [...inheritedBinds, ...localBinds].entries()) {
    const inherited = index < inheritedBinds.length;
    const parsed = splitSandboxBindSpec(bind, { allowWindowsContainerPath: true });
    const bindMode = parsed?.options
      .split(",")
      .some((option) => option.trim().toLowerCase() === "ro")
      ? "ro"
      : "rw";
    pushSandboxPostureValue(entries, params, {
      suffix: `${surface}/bind/${index}`,
      kind: "containerMount",
      sourceSuffix: `${configSurface}/binds/#${inherited ? index : index - inheritedBinds.length}`,
      inherited,
      bind,
      bindHost: parsed?.host,
      bindMode,
      bindSurface: surface,
      explicit: true,
    });
  }
}

function pushSandboxBrowserPosture(
  entries: PolicySandboxPostureEvidence[],
  params: SandboxPostureParams,
): void {
  const localBrowser = !params.sharedSandboxScope ? asNonArrayRecord(params.sandbox.browser) : {};
  const inheritedBrowser = asNonArrayRecord(params.inheritedSandbox.browser);
  const localEnabled = readBoolean(localBrowser.enabled);
  const inheritedEnabled = readBoolean(inheritedBrowser.enabled);
  const enabled = localEnabled ?? inheritedEnabled ?? false;
  if (!enabled && localEnabled === undefined && inheritedEnabled === undefined) {
    return;
  }
  const hasLocalRange = Object.hasOwn(localBrowser, "cdpSourceRange");
  const localRange = readString(localBrowser.cdpSourceRange);
  const inheritedRange = readString(inheritedBrowser.cdpSourceRange);
  const inherited = enabled
    ? !hasLocalRange && inheritedRange !== undefined
    : localEnabled === undefined && inheritedEnabled !== undefined;
  const value = enabled ? (hasLocalRange ? localRange : inheritedRange) : false;
  pushSandboxPostureValue(entries, params, {
    suffix: "browser/cdp-source-range",
    sourceSuffix: `browser/${enabled ? "cdpSourceRange" : "enabled"}`,
    kind: "browserCdpSourceRange",
    inherited,
    value,
    explicit: value !== undefined,
  });
  if (!enabled) {
    return;
  }

  pushSandboxPostureValue(entries, params, {
    suffix: "browser/network",
    kind: "containerNetwork",
    ...resolvePolicyValue(
      readString(localBrowser.network),
      readString(inheritedBrowser.network),
      DEFAULT_POLICY_SANDBOX_BROWSER_NETWORK,
    ),
    networkSurface: "browser",
  });

  const browserBindsConfigured =
    inheritedBrowser.binds !== undefined || localBrowser.binds !== undefined;
  if (browserBindsConfigured) {
    pushSandboxBindPosture(entries, params, "browser");
  } else if (params.effectiveBackend !== "docker" && params.effectiveBackend !== "podman") {
    pushSandboxBindPosture(entries, params, "browser", "docker");
  }
}

function pushSandboxPostureValue(
  entries: PolicySandboxPostureEvidence[],
  params: SandboxPostureParams,
  entry: Omit<PolicySandboxPostureEvidence, "id" | "source" | "scope" | "agentId"> & {
    readonly suffix: string;
    readonly sourceSuffix?: string;
    readonly inherited: boolean;
  },
): void {
  const { suffix, sourceSuffix = suffix, inherited, value, ...evidence } = entry;
  entries.push({
    id: `${params.id}-${suffix.replaceAll("/", "-")}`,
    source: `${inherited ? "oc://openclaw.config/agents/defaults/sandbox" : params.sourceBase}/${sourceSuffix}`,
    scope: params.scope,
    ...(params.agentId === undefined ? {} : { agentId: params.agentId }),
    ...(value === undefined ? {} : { value }),
    ...evidence,
  });
}
