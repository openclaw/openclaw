import { splitSandboxBindSpec } from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  asNonArrayRecord,
  isRecord,
  asBoolean as readBoolean,
  normalizeOptionalString as readString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { collectPolicyConfiguredAgents, resolvePolicyValue } from "./policy-state-helpers.js";
import { readStringArray } from "./policy-state-tool-posture.js";
import type { PolicySandboxPostureEvidence } from "./policy-state-types.js";

// Mirrors the sandbox browser config default without importing core internals into the policy plugin.
const DEFAULT_POLICY_SANDBOX_BROWSER_NETWORK = "openclaw-sandbox-browser";

export function scanPolicySandboxPosture(
  cfg: Record<string, unknown>,
): readonly PolicySandboxPostureEvidence[] {
  const agents = asNonArrayRecord(cfg.agents);
  const defaults = asNonArrayRecord(agents.defaults);
  const defaultSandbox = asNonArrayRecord(defaults.sandbox);
  const entries: PolicySandboxPostureEvidence[] = [];
  pushSandboxPostureEvidence(entries, {
    id: "agents-defaults",
    scope: "defaults",
    sandbox: defaultSandbox,
    inheritedSandbox: {},
    sourceBase: "oc://openclaw.config/agents/defaults/sandbox",
  });

  collectPolicyConfiguredAgents(agents).forEach((configured) => {
    const agent = configured.value;
    if (!isRecord(agent)) {
      return;
    }
    const sandbox = asNonArrayRecord(agent.sandbox);
    pushSandboxPostureEvidence(entries, {
      id: configured.agentId,
      scope: "agent",
      agentId: configured.agentId,
      sandbox,
      inheritedSandbox: defaultSandbox,
      sharedSandboxScope: sandboxScopeIsShared(sandbox, defaultSandbox),
      sourceBase: `${configured.sourceBase}/sandbox`,
    });
  });

  return entries.toSorted((a, b) => a.source.localeCompare(b.source) || a.id.localeCompare(b.id));
}

type SandboxPostureParams = {
  readonly id: string;
  readonly scope: "defaults" | "agent";
  readonly agentId?: string;
  readonly effectiveBackend?: string;
  readonly sandbox: Record<string, unknown>;
  readonly inheritedSandbox: Record<string, unknown>;
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
    entries.push({
      id: `${params.id}-docker-${profile}-profile`,
      kind: "containerSecurityProfile",
      source: `${inherited ? "oc://openclaw.config/agents/defaults/sandbox" : params.sourceBase}/docker/${key}`,
      scope: params.scope,
      ...(params.agentId === undefined ? {} : { agentId: params.agentId }),
      profile,
      ...(value === undefined ? {} : { value }),
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
    entries.push({
      id: `${params.id}-${surface}-bind-${index}`,
      kind: "containerMount",
      source: `${inherited ? "oc://openclaw.config/agents/defaults/sandbox" : params.sourceBase}/${configSurface}/binds/#${
        inherited ? index : index - inheritedBinds.length
      }`,
      scope: params.scope,
      ...(params.agentId === undefined ? {} : { agentId: params.agentId }),
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
  entries.push({
    id: `${params.id}-browser-cdp-source-range`,
    kind: "browserCdpSourceRange",
    source: `${inherited ? "oc://openclaw.config/agents/defaults/sandbox" : params.sourceBase}/browser/${enabled ? "cdpSourceRange" : "enabled"}`,
    scope: params.scope,
    ...(params.agentId === undefined ? {} : { agentId: params.agentId }),
    ...(value === undefined ? {} : { value }),
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

function sandboxScopeIsShared(
  sandbox: Record<string, unknown>,
  inheritedSandbox: Record<string, unknown>,
): boolean {
  const localScope = readString(sandbox.scope);
  const inheritedScope = readString(inheritedSandbox.scope);
  return (localScope ?? inheritedScope) === "shared";
}

function pushSandboxPostureValue(
  entries: PolicySandboxPostureEvidence[],
  params: SandboxPostureParams,
  entry: {
    readonly suffix: string;
    readonly kind: PolicySandboxPostureEvidence["kind"];
    readonly value: string | undefined;
    readonly networkSurface?: "browser" | "docker";
    readonly explicit: boolean;
    readonly inherited: boolean;
  },
): void {
  entries.push({
    id: `${params.id}-${entry.suffix.replaceAll("/", "-")}`,
    kind: entry.kind,
    source: `${entry.inherited ? "oc://openclaw.config/agents/defaults/sandbox" : params.sourceBase}/${entry.suffix}`,
    scope: params.scope,
    ...(params.agentId === undefined ? {} : { agentId: params.agentId }),
    ...(entry.value === undefined ? {} : { value: entry.value }),
    ...(entry.networkSurface === undefined ? {} : { networkSurface: entry.networkSurface }),
    explicit: entry.explicit,
  });
}
