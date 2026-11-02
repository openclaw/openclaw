import { splitSandboxBindSpec } from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  asNonArrayRecord,
  asBoolean as readBoolean,
  normalizeOptionalString as readString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { collectPolicyAgentContexts, resolvePolicyValue } from "./policy-state-helpers.js";
import { readStringArray } from "./policy-state-tool-posture.js";
import type { PolicySandboxPostureEvidence } from "./policy-state-types.js";

// Mirrors the sandbox browser config default without importing core internals into the policy plugin.
const DEFAULT_POLICY_SANDBOX_BROWSER_NETWORK = "openclaw-sandbox-browser";

export function scanPolicySandboxPosture(
  cfg: Record<string, unknown>,
): readonly PolicySandboxPostureEvidence[] {
  const entries: PolicySandboxPostureEvidence[] = [];
  for (const context of collectPolicyAgentContexts(cfg, "defaults")) {
    const sharedSandboxScope =
      context.scope === "agent" &&
      (readString(context.sandbox.scope) ?? readString(context.inheritedSandbox.scope)) ===
        "shared";
    const sourceBase = `${context.workspaceSourceBase}/sandbox`;
    pushSandboxPostureValue({
      suffix: "mode",
      kind: "mode",
      ...resolvePolicyValue(
        readString(context.sandbox.mode),
        readString(context.inheritedSandbox.mode),
        "off",
      ),
    });

    const backend = resolvePolicyValue(
      readString(context.sandbox.backend),
      readString(context.inheritedSandbox.backend),
      "docker",
    );
    const effectiveBackend = backend.value.toLowerCase();
    pushSandboxPostureValue({
      suffix: "backend",
      kind: "backend",
      ...backend,
      value: effectiveBackend,
    });

    if (effectiveBackend === "docker" || effectiveBackend === "podman") {
      const localDocker = !sharedSandboxScope ? asNonArrayRecord(context.sandbox.docker) : {};
      const inheritedDocker = asNonArrayRecord(context.inheritedSandbox.docker);
      pushSandboxPostureValue({
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
        pushSandboxPostureValue({
          suffix: `docker/${profile}/profile`,
          sourceSuffix: `docker/${key}`,
          kind: "containerSecurityProfile",
          inherited,
          profile,
          value,
          explicit: value !== undefined,
        });
      }
      pushSandboxBindPosture("docker");
    }

    function pushSandboxBindPosture(surface: "browser" | "docker", configSurface = surface): void {
      const local = !sharedSandboxScope ? asNonArrayRecord(context.sandbox[configSurface]) : {};
      const inheritedConfig = asNonArrayRecord(context.inheritedSandbox[configSurface]);
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
        pushSandboxPostureValue({
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

    const localBrowser = !sharedSandboxScope ? asNonArrayRecord(context.sandbox.browser) : {};
    const inheritedBrowser = asNonArrayRecord(context.inheritedSandbox.browser);
    const localEnabled = readBoolean(localBrowser.enabled);
    const inheritedEnabled = readBoolean(inheritedBrowser.enabled);
    const enabled = localEnabled ?? inheritedEnabled ?? false;
    if (!enabled && localEnabled === undefined && inheritedEnabled === undefined) {
      continue;
    }
    const hasLocalRange = Object.hasOwn(localBrowser, "cdpSourceRange");
    const localRange = readString(localBrowser.cdpSourceRange);
    const inheritedRange = readString(inheritedBrowser.cdpSourceRange);
    const browserInherited = enabled
      ? !hasLocalRange && inheritedRange !== undefined
      : localEnabled === undefined && inheritedEnabled !== undefined;
    const browserValue = enabled ? (hasLocalRange ? localRange : inheritedRange) : false;
    pushSandboxPostureValue({
      suffix: "browser/cdp-source-range",
      sourceSuffix: `browser/${enabled ? "cdpSourceRange" : "enabled"}`,
      kind: "browserCdpSourceRange",
      inherited: browserInherited,
      value: browserValue,
      explicit: browserValue !== undefined,
    });
    if (!enabled) {
      continue;
    }

    pushSandboxPostureValue({
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
      pushSandboxBindPosture("browser");
    } else if (effectiveBackend !== "docker" && effectiveBackend !== "podman") {
      pushSandboxBindPosture("browser", "docker");
    }

    function pushSandboxPostureValue(
      entry: Omit<PolicySandboxPostureEvidence, "id" | "source" | "scope" | "agentId"> & {
        readonly suffix: string;
        readonly sourceSuffix?: string;
        readonly inherited: boolean;
      },
    ): void {
      const { suffix, sourceSuffix = suffix, inherited, value, ...evidence } = entry;
      entries.push({
        id: `${context.id}-${suffix.replaceAll("/", "-")}`,
        source: `${inherited ? "oc://openclaw.config/agents/defaults/sandbox" : sourceBase}/${sourceSuffix}`,
        scope: context.scope,
        ...(context.agentId === undefined ? {} : { agentId: context.agentId }),
        ...(value === undefined ? {} : { value }),
        ...evidence,
      });
    }
  }

  return entries.toSorted((a, b) => a.source.localeCompare(b.source) || a.id.localeCompare(b.id));
}
