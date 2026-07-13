import type { HealthFinding } from "openclaw/plugin-sdk/health";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { PolicyDataHandlingEvidence, PolicyEvidence } from "../policy-state.js";
import { POLICY_CHECK_IDS, SANDBOX_CONTAINER_POLICY_RULES } from "./metadata.js";
import {
  SUPPORTED_AGENT_WORKSPACE_DENY_TOOLS,
  SUPPORTED_AUTH_PROFILE_MODES,
  SUPPORTED_GATEWAY_HTTP_ENDPOINTS,
  SUPPORTED_GATEWAY_POLICY_SECTIONS,
  SUPPORTED_SANDBOX_MODES,
  SUPPORTED_TOOL_EXEC_ASK,
  SUPPORTED_TOOL_EXEC_HOST,
  SUPPORTED_TOOL_EXEC_SECURITY,
  SUPPORTED_TOOL_PROFILES,
} from "./policy-constants.js";
import { getPolicyPath } from "./policy-scope.js";
import {
  policyShapeFinding,
  policyStringArrayPropertyShapeFinding,
  unsupportedPolicyKey,
} from "./shape-helpers.js";
import { ocPathSegment } from "./utils.js";

export function agentWorkspacePolicyShapeFinding(
  value: unknown,
  params: {
    readonly policyDocName: string;
    readonly policyPath: string;
    readonly targetPrefix: string;
    readonly propertyPrefix: string;
  },
): HealthFinding | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    return policyShapeFinding(
      params.policyPath,
      `oc://${params.policyDocName}/${params.targetPrefix}`,
      `${params.policyPath} ${params.propertyPrefix} must be an object.`,
      `Fix ${params.policyPath} so ${params.propertyPrefix} is an object.`,
    );
  }
  const unsupportedWorkspaceKey = unsupportedPolicyKey(value, ["allowedAccess", "denyTools"]);
  if (unsupportedWorkspaceKey !== undefined) {
    return policyShapeFinding(
      params.policyPath,
      `oc://${params.policyDocName}/${params.targetPrefix}/${ocPathSegment(unsupportedWorkspaceKey)}`,
      `${params.policyPath} ${params.propertyPrefix}.${unsupportedWorkspaceKey} is not supported in agent workspace policy.`,
      `Remove ${params.propertyPrefix}.${unsupportedWorkspaceKey} or use a supported agent workspace policy rule.`,
    );
  }
  const allowedAccess = value.allowedAccess;
  if (allowedAccess !== undefined && !Array.isArray(allowedAccess)) {
    return policyShapeFinding(
      params.policyPath,
      `oc://${params.policyDocName}/${params.targetPrefix}/allowedAccess`,
      `${params.policyPath} ${params.propertyPrefix}.allowedAccess must be an array.`,
      'Use workspace access values such as ["none", "ro"].',
    );
  }
  if (Array.isArray(allowedAccess)) {
    const invalidIndex = allowedAccess.findIndex(
      (entry) => entry !== "none" && entry !== "ro" && entry !== "rw",
    );
    if (invalidIndex >= 0) {
      return policyShapeFinding(
        params.policyPath,
        `oc://${params.policyDocName}/${params.targetPrefix}/allowedAccess/#${invalidIndex}`,
        `${params.policyPath} ${params.propertyPrefix}.allowedAccess[${invalidIndex}] must be none, ro, or rw.`,
        'Use workspace access values such as ["none", "ro"].',
      );
    }
  }
  const denyTools = value.denyTools;
  if (denyTools !== undefined && !Array.isArray(denyTools)) {
    return policyShapeFinding(
      params.policyPath,
      `oc://${params.policyDocName}/${params.targetPrefix}/denyTools`,
      `${params.policyPath} ${params.propertyPrefix}.denyTools must be an array.`,
      'Use tool ids such as ["exec", "process", "write", "edit", "apply_patch"].',
    );
  }
  if (Array.isArray(denyTools)) {
    const invalidIndex = denyTools.findIndex(
      (entry) =>
        typeof entry !== "string" ||
        !SUPPORTED_AGENT_WORKSPACE_DENY_TOOLS.includes(
          entry.trim() as (typeof SUPPORTED_AGENT_WORKSPACE_DENY_TOOLS)[number],
        ),
    );
    if (invalidIndex >= 0) {
      return policyShapeFinding(
        params.policyPath,
        `oc://${params.policyDocName}/${params.targetPrefix}/denyTools/#${invalidIndex}`,
        `${params.policyPath} ${params.propertyPrefix}.denyTools[${invalidIndex}] must be a supported agent workspace tool id.`,
        `Use supported tool ids: ${SUPPORTED_AGENT_WORKSPACE_DENY_TOOLS.join(", ")}.`,
      );
    }
  }
  return undefined;
}

export function toolPosturePolicyShapeFinding(
  tools: Record<string, unknown>,
  params: {
    readonly policyDocName: string;
    readonly policyPath: string;
    readonly targetPrefix?: string;
    readonly propertyPrefix?: string;
  },
): HealthFinding | undefined {
  const targetPrefix = params.targetPrefix ?? "tools";
  const propertyPrefix = params.propertyPrefix ?? "tools";
  const allowedTopLevel = [
    "alsoAllow",
    "denyTools",
    "elevated",
    "exec",
    "fs",
    "profiles",
    "requireMetadata",
  ];
  const unsupportedTopLevel = unsupportedPolicyKey(tools, allowedTopLevel);
  if (unsupportedTopLevel !== undefined) {
    return policyShapeFinding(
      params.policyPath,
      `oc://${params.policyDocName}/${targetPrefix}/${ocPathSegment(unsupportedTopLevel)}`,
      `${params.policyPath} ${propertyPrefix}.${unsupportedTopLevel} is not supported in tools policy.`,
      `Remove ${propertyPrefix}.${unsupportedTopLevel} or use a supported tools policy rule.`,
    );
  }
  for (const section of ["profiles", "fs", "exec", "elevated", "alsoAllow"] as const) {
    if (tools[section] !== undefined && !isRecord(tools[section])) {
      return policyShapeFinding(
        params.policyPath,
        `oc://${params.policyDocName}/${targetPrefix}/${section}`,
        `${params.policyPath} ${propertyPrefix}.${section} must be an object.`,
        `Fix ${params.policyPath} so ${propertyPrefix}.${section} is an object.`,
      );
    }
  }

  const profiles = isRecord(tools.profiles) ? tools.profiles : {};
  const unsupportedProfileKey = unsupportedPolicyKey(profiles, ["allow"]);
  if (unsupportedProfileKey !== undefined) {
    return policyShapeFinding(
      params.policyPath,
      `oc://${params.policyDocName}/${targetPrefix}/profiles/${ocPathSegment(unsupportedProfileKey)}`,
      `${params.policyPath} ${propertyPrefix}.profiles.${unsupportedProfileKey} is not supported in tools policy.`,
      `Remove ${propertyPrefix}.profiles.${unsupportedProfileKey} or use ${propertyPrefix}.profiles.allow.`,
    );
  }
  const profileAllowFinding = policyStringArrayPropertyShapeFinding(profiles.allow, {
    allowed: SUPPORTED_TOOL_PROFILES,
    policyDocName: params.policyDocName,
    policyPath: params.policyPath,
    property: `${propertyPrefix}.profiles.allow`,
    target: `${targetPrefix}/profiles/allow`,
    valueName: "tool profile id",
  });
  if (profileAllowFinding !== undefined) {
    return profileAllowFinding;
  }

  const fs = isRecord(tools.fs) ? tools.fs : {};
  const unsupportedFsKey = unsupportedPolicyKey(fs, ["requireWorkspaceOnly"]);
  if (unsupportedFsKey !== undefined) {
    return policyShapeFinding(
      params.policyPath,
      `oc://${params.policyDocName}/${targetPrefix}/fs/${ocPathSegment(unsupportedFsKey)}`,
      `${params.policyPath} ${propertyPrefix}.fs.${unsupportedFsKey} is not supported in tools policy.`,
      `Remove ${propertyPrefix}.fs.${unsupportedFsKey} or use ${propertyPrefix}.fs.requireWorkspaceOnly.`,
    );
  }
  if (fs.requireWorkspaceOnly !== undefined && typeof fs.requireWorkspaceOnly !== "boolean") {
    return policyShapeFinding(
      params.policyPath,
      `oc://${params.policyDocName}/${targetPrefix}/fs/requireWorkspaceOnly`,
      `${params.policyPath} ${propertyPrefix}.fs.requireWorkspaceOnly must be a boolean.`,
      `Set ${propertyPrefix}.fs.requireWorkspaceOnly to true or false.`,
    );
  }

  const exec = isRecord(tools.exec) ? tools.exec : {};
  const unsupportedExecKey = unsupportedPolicyKey(exec, [
    "allowHosts",
    "allowSecurity",
    "requireAsk",
  ]);
  if (unsupportedExecKey !== undefined) {
    return policyShapeFinding(
      params.policyPath,
      `oc://${params.policyDocName}/${targetPrefix}/exec/${ocPathSegment(unsupportedExecKey)}`,
      `${params.policyPath} ${propertyPrefix}.exec.${unsupportedExecKey} is not supported in tools policy.`,
      `Remove ${propertyPrefix}.exec.${unsupportedExecKey} or use a supported tools exec policy rule.`,
    );
  }
  const execLists = [
    ["allowSecurity", SUPPORTED_TOOL_EXEC_SECURITY, "exec security mode"],
    ["requireAsk", SUPPORTED_TOOL_EXEC_ASK, "exec ask mode"],
    ["allowHosts", SUPPORTED_TOOL_EXEC_HOST, "exec host"],
  ] as const;
  for (const [key, supported, valueName] of execLists) {
    const finding = policyStringArrayPropertyShapeFinding(exec[key], {
      allowed: supported,
      policyDocName: params.policyDocName,
      policyPath: params.policyPath,
      property: `${propertyPrefix}.exec.${key}`,
      target: `${targetPrefix}/exec/${key}`,
      valueName,
    });
    if (finding !== undefined) {
      return finding;
    }
  }

  const elevated = isRecord(tools.elevated) ? tools.elevated : {};
  const unsupportedElevatedKey = unsupportedPolicyKey(elevated, ["allow"]);
  if (unsupportedElevatedKey !== undefined) {
    return policyShapeFinding(
      params.policyPath,
      `oc://${params.policyDocName}/${targetPrefix}/elevated/${ocPathSegment(unsupportedElevatedKey)}`,
      `${params.policyPath} ${propertyPrefix}.elevated.${unsupportedElevatedKey} is not supported in tools policy.`,
      `Remove ${propertyPrefix}.elevated.${unsupportedElevatedKey} or use ${propertyPrefix}.elevated.allow.`,
    );
  }
  if (elevated.allow !== undefined && typeof elevated.allow !== "boolean") {
    return policyShapeFinding(
      params.policyPath,
      `oc://${params.policyDocName}/${targetPrefix}/elevated/allow`,
      `${params.policyPath} ${propertyPrefix}.elevated.allow must be a boolean.`,
      `Set ${propertyPrefix}.elevated.allow to true or false.`,
    );
  }

  const alsoAllow = isRecord(tools.alsoAllow) ? tools.alsoAllow : {};
  const unsupportedAlsoAllowKey = unsupportedPolicyKey(alsoAllow, ["expected"]);
  if (unsupportedAlsoAllowKey !== undefined) {
    return policyShapeFinding(
      params.policyPath,
      `oc://${params.policyDocName}/${targetPrefix}/alsoAllow/${ocPathSegment(unsupportedAlsoAllowKey)}`,
      `${params.policyPath} ${propertyPrefix}.alsoAllow.${unsupportedAlsoAllowKey} is not supported in tools policy.`,
      `Remove ${propertyPrefix}.alsoAllow.${unsupportedAlsoAllowKey} or use ${propertyPrefix}.alsoAllow.expected.`,
    );
  }
  const alsoAllowExpectedFinding = policyStringArrayPropertyShapeFinding(alsoAllow.expected, {
    policyDocName: params.policyDocName,
    policyPath: params.policyPath,
    property: `${propertyPrefix}.alsoAllow.expected`,
    target: `${targetPrefix}/alsoAllow/expected`,
    valueName: "tool id",
  });
  if (alsoAllowExpectedFinding !== undefined) {
    return alsoAllowExpectedFinding;
  }

  const denyToolsFinding = policyStringArrayPropertyShapeFinding(tools.denyTools, {
    policyDocName: params.policyDocName,
    policyPath: params.policyPath,
    property: `${propertyPrefix}.denyTools`,
    target: `${targetPrefix}/denyTools`,
    valueName: "tool id or group",
  });
  return denyToolsFinding;
}

export function sandboxPolicyShapeFinding(
  value: unknown,
  params: {
    readonly policyDocName: string;
    readonly policyPath: string;
    readonly targetPrefix?: string;
    readonly propertyPrefix?: string;
  },
): HealthFinding | undefined {
  const targetPrefix = params.targetPrefix ?? "sandbox";
  const propertyPrefix = params.propertyPrefix ?? "sandbox";
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    return policyShapeFinding(
      params.policyPath,
      `oc://${params.policyDocName}/${targetPrefix}`,
      `${params.policyPath} ${propertyPrefix} must be an object.`,
      `Fix ${params.policyPath} so ${propertyPrefix} is an object.`,
    );
  }
  const unsupportedTopLevel = unsupportedPolicyKey(value, [
    "requireMode",
    "allowBackends",
    "containers",
    "browser",
  ]);
  if (unsupportedTopLevel !== undefined) {
    return policyShapeFinding(
      params.policyPath,
      `oc://${params.policyDocName}/${targetPrefix}/${ocPathSegment(unsupportedTopLevel)}`,
      `${params.policyPath} ${propertyPrefix}.${unsupportedTopLevel} is not supported in sandbox policy.`,
      `Remove ${propertyPrefix}.${unsupportedTopLevel} or use a supported sandbox posture rule.`,
    );
  }
  const modeFinding = policyStringArrayPropertyShapeFinding(value.requireMode, {
    allowed: SUPPORTED_SANDBOX_MODES,
    policyDocName: params.policyDocName,
    policyPath: params.policyPath,
    property: `${propertyPrefix}.requireMode`,
    target: `${targetPrefix}/requireMode`,
    valueName: "sandbox mode",
  });
  if (modeFinding !== undefined) {
    return modeFinding;
  }
  const backendFinding = policyStringArrayPropertyShapeFinding(value.allowBackends, {
    policyDocName: params.policyDocName,
    policyPath: params.policyPath,
    property: `${propertyPrefix}.allowBackends`,
    target: `${targetPrefix}/allowBackends`,
    valueName: "sandbox backend id",
  });
  if (backendFinding !== undefined) {
    return backendFinding;
  }
  for (const section of ["containers", "browser"] as const) {
    if (value[section] !== undefined && !isRecord(value[section])) {
      return policyShapeFinding(
        params.policyPath,
        `oc://${params.policyDocName}/${targetPrefix}/${section}`,
        `${params.policyPath} ${propertyPrefix}.${section} must be an object.`,
        `Fix ${params.policyPath} so ${propertyPrefix}.${section} is an object.`,
      );
    }
  }
  const containers = isRecord(value.containers) ? value.containers : {};
  const unsupportedContainerKey = unsupportedPolicyKey(
    containers,
    SANDBOX_CONTAINER_POLICY_RULES.map((rule) => rule.key),
  );
  if (unsupportedContainerKey !== undefined) {
    return policyShapeFinding(
      params.policyPath,
      `oc://${params.policyDocName}/${targetPrefix}/containers/${ocPathSegment(unsupportedContainerKey)}`,
      `${params.policyPath} ${propertyPrefix}.containers.${unsupportedContainerKey} is not supported in sandbox policy.`,
      `Remove ${propertyPrefix}.containers.${unsupportedContainerKey} or use a supported sandbox container posture rule.`,
    );
  }
  for (const { key } of SANDBOX_CONTAINER_POLICY_RULES) {
    if (containers[key] !== undefined && typeof containers[key] !== "boolean") {
      return policyShapeFinding(
        params.policyPath,
        `oc://${params.policyDocName}/${targetPrefix}/containers/${key}`,
        `${params.policyPath} ${propertyPrefix}.containers.${key} must be a boolean.`,
        `Set ${propertyPrefix}.containers.${key} to true or false.`,
      );
    }
  }
  const browser = isRecord(value.browser) ? value.browser : {};
  const unsupportedBrowserKey = unsupportedPolicyKey(browser, ["requireCdpSourceRange"]);
  if (unsupportedBrowserKey !== undefined) {
    return policyShapeFinding(
      params.policyPath,
      `oc://${params.policyDocName}/${targetPrefix}/browser/${ocPathSegment(unsupportedBrowserKey)}`,
      `${params.policyPath} ${propertyPrefix}.browser.${unsupportedBrowserKey} is not supported in sandbox policy.`,
      `Remove ${propertyPrefix}.browser.${unsupportedBrowserKey} or use a supported sandbox browser posture rule.`,
    );
  }
  if (
    browser.requireCdpSourceRange !== undefined &&
    typeof browser.requireCdpSourceRange !== "boolean"
  ) {
    return policyShapeFinding(
      params.policyPath,
      `oc://${params.policyDocName}/${targetPrefix}/browser/requireCdpSourceRange`,
      `${params.policyPath} ${propertyPrefix}.browser.requireCdpSourceRange must be a boolean.`,
      `Set ${propertyPrefix}.browser.requireCdpSourceRange to true or false.`,
    );
  }
  return undefined;
}

export function gatewayPolicyShapeFinding(
  value: unknown,
  params: {
    readonly policyDocName: string;
    readonly policyPath: string;
  },
): HealthFinding | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    return policyShapeFinding(
      params.policyPath,
      `oc://${params.policyDocName}/gateway`,
      `${params.policyPath} gateway must be an object.`,
      `Fix ${params.policyPath} so gateway is an object.`,
    );
  }

  for (const section of ["exposure", "auth", "controlUi", "remote", "http", "nodes"] as const) {
    if (value[section] !== undefined && !isRecord(value[section])) {
      return policyShapeFinding(
        params.policyPath,
        `oc://${params.policyDocName}/gateway/${section}`,
        `${params.policyPath} gateway.${section} must be an object.`,
        `Fix ${params.policyPath} so gateway.${section} is an object.`,
      );
    }
  }
  const unsupportedGatewayKey = unsupportedPolicyKey(value, SUPPORTED_GATEWAY_POLICY_SECTIONS);
  if (unsupportedGatewayKey !== undefined) {
    return policyShapeFinding(
      params.policyPath,
      `oc://${params.policyDocName}/gateway/${ocPathSegment(unsupportedGatewayKey)}`,
      `${params.policyPath} gateway.${unsupportedGatewayKey} is not supported in Gateway policy.`,
      `Remove gateway.${unsupportedGatewayKey} or use a supported Gateway policy section.`,
    );
  }

  const exposure = isRecord(value.exposure) ? value.exposure : {};
  const auth = isRecord(value.auth) ? value.auth : {};
  const controlUi = isRecord(value.controlUi) ? value.controlUi : {};
  const remote = isRecord(value.remote) ? value.remote : {};
  const http = isRecord(value.http) ? value.http : {};
  const nodes = isRecord(value.nodes) ? value.nodes : {};
  for (const [section, sectionValue, allowedKeys] of [
    ["exposure", exposure, ["allowNonLoopbackBind", "allowTailscaleFunnel"]],
    ["auth", auth, ["requireAuth", "requireExplicitRateLimit"]],
    ["controlUi", controlUi, ["allowInsecure"]],
    ["remote", remote, ["allow"]],
    ["http", http, ["denyEndpoints", "requireUrlAllowlists"]],
    ["nodes", nodes, ["denyCommands"]],
  ] as const) {
    const unsupportedKey = unsupportedPolicyKey(sectionValue, allowedKeys);
    if (unsupportedKey !== undefined) {
      return policyShapeFinding(
        params.policyPath,
        `oc://${params.policyDocName}/gateway/${section}/${ocPathSegment(unsupportedKey)}`,
        `${params.policyPath} gateway.${section}.${unsupportedKey} is not supported in Gateway policy.`,
        `Remove gateway.${section}.${unsupportedKey} or use a supported Gateway policy rule.`,
      );
    }
  }
  const booleanRules = [
    [
      "gateway/exposure/allowNonLoopbackBind",
      "gateway.exposure.allowNonLoopbackBind",
      exposure.allowNonLoopbackBind,
    ],
    [
      "gateway/exposure/allowTailscaleFunnel",
      "gateway.exposure.allowTailscaleFunnel",
      exposure.allowTailscaleFunnel,
    ],
    ["gateway/auth/requireAuth", "gateway.auth.requireAuth", auth.requireAuth],
    [
      "gateway/auth/requireExplicitRateLimit",
      "gateway.auth.requireExplicitRateLimit",
      auth.requireExplicitRateLimit,
    ],
    ["gateway/controlUi/allowInsecure", "gateway.controlUi.allowInsecure", controlUi.allowInsecure],
    ["gateway/remote/allow", "gateway.remote.allow", remote.allow],
    [
      "gateway/http/requireUrlAllowlists",
      "gateway.http.requireUrlAllowlists",
      http.requireUrlAllowlists,
    ],
  ] as const;
  for (const [target, property, ruleValue] of booleanRules) {
    if (ruleValue !== undefined && typeof ruleValue !== "boolean") {
      return policyShapeFinding(
        params.policyPath,
        `oc://${params.policyDocName}/${target}`,
        `${params.policyPath} ${property} must be a boolean.`,
        `Fix ${params.policyPath} so ${property} is true or false.`,
      );
    }
  }

  const denyEndpoints = http.denyEndpoints;
  if (denyEndpoints !== undefined && !Array.isArray(denyEndpoints)) {
    return policyShapeFinding(
      params.policyPath,
      `oc://${params.policyDocName}/gateway/http/denyEndpoints`,
      `${params.policyPath} gateway.http.denyEndpoints must be an array.`,
      'Use an array of endpoint ids such as ["responses"] or remove gateway.http.denyEndpoints.',
    );
  }
  if (Array.isArray(denyEndpoints)) {
    const invalidIndex = denyEndpoints.findIndex(
      (entry) =>
        typeof entry !== "string" ||
        !SUPPORTED_GATEWAY_HTTP_ENDPOINTS.includes(
          entry.trim() as (typeof SUPPORTED_GATEWAY_HTTP_ENDPOINTS)[number],
        ),
    );
    if (invalidIndex >= 0) {
      return policyShapeFinding(
        params.policyPath,
        `oc://${params.policyDocName}/gateway/http/denyEndpoints/#${invalidIndex}`,
        `${params.policyPath} gateway.http.denyEndpoints[${invalidIndex}] must be a supported endpoint id.`,
        `Use supported endpoint ids: ${SUPPORTED_GATEWAY_HTTP_ENDPOINTS.join(", ")}.`,
      );
    }
  }
  const denyCommands = nodes.denyCommands;
  if (denyCommands !== undefined && !Array.isArray(denyCommands)) {
    return policyShapeFinding(
      params.policyPath,
      `oc://${params.policyDocName}/gateway/nodes/denyCommands`,
      `${params.policyPath} gateway.nodes.denyCommands must be an array.`,
      'Use an array of node command ids such as ["system.run"] or remove gateway.nodes.denyCommands.',
    );
  }
  if (Array.isArray(denyCommands)) {
    const invalidIndex = denyCommands.findIndex(
      (entry) => typeof entry !== "string" || entry.trim() === "",
    );
    if (invalidIndex >= 0) {
      return policyShapeFinding(
        params.policyPath,
        `oc://${params.policyDocName}/gateway/nodes/denyCommands/#${invalidIndex}`,
        `${params.policyPath} gateway.nodes.denyCommands[${invalidIndex}] must be a non-empty node command id.`,
        "Use non-empty node command ids.",
      );
    }
  }
  return undefined;
}

export function dataHandlingPolicyShapeFindings(
  policy: unknown,
  policyPath: string,
  policyDocName: string,
): readonly HealthFinding[] {
  if (!isRecord(policy)) {
    return [];
  }
  if (!isRecord(policy.dataHandling)) {
    return [];
  }
  return [
    policySectionUnsupportedKeyFinding(policy.dataHandling, {
      policyPath,
      policyDocName,
      propertyPath: "dataHandling",
      targetPath: "dataHandling",
      sectionName: "data-handling",
      allowedKeys: ["memory", "retention", "sensitiveLogging", "telemetry"],
    }),
    dataHandlingSectionShapeFinding(policy.dataHandling, {
      policyPath,
      policyDocName,
      propertyPath: "dataHandling.sensitiveLogging",
      targetPath: "dataHandling/sensitiveLogging",
      section: "sensitiveLogging",
    }),
    dataHandlingSectionShapeFinding(policy.dataHandling, {
      policyPath,
      policyDocName,
      propertyPath: "dataHandling.telemetry",
      targetPath: "dataHandling/telemetry",
      section: "telemetry",
    }),
    dataHandlingSectionShapeFinding(policy.dataHandling, {
      policyPath,
      policyDocName,
      propertyPath: "dataHandling.retention",
      targetPath: "dataHandling/retention",
      section: "retention",
    }),
    dataHandlingSectionShapeFinding(policy.dataHandling, {
      policyPath,
      policyDocName,
      propertyPath: "dataHandling.memory",
      targetPath: "dataHandling/memory",
      section: "memory",
    }),
    dataHandlingBooleanShapeFinding(policy.dataHandling, {
      policyPath,
      policyDocName,
      propertyPath: "dataHandling.sensitiveLogging.requireRedaction",
      targetPath: "dataHandling/sensitiveLogging/requireRedaction",
      path: ["sensitiveLogging", "requireRedaction"],
    }),
    dataHandlingBooleanShapeFinding(policy.dataHandling, {
      policyPath,
      policyDocName,
      propertyPath: "dataHandling.telemetry.denyContentCapture",
      targetPath: "dataHandling/telemetry/denyContentCapture",
      path: ["telemetry", "denyContentCapture"],
    }),
    dataHandlingBooleanShapeFinding(policy.dataHandling, {
      policyPath,
      policyDocName,
      propertyPath: "dataHandling.retention.requireSessionMaintenance",
      targetPath: "dataHandling/retention/requireSessionMaintenance",
      path: ["retention", "requireSessionMaintenance"],
    }),
    dataHandlingBooleanShapeFinding(policy.dataHandling, {
      policyPath,
      policyDocName,
      propertyPath: "dataHandling.memory.denySessionTranscriptIndexing",
      targetPath: "dataHandling/memory/denySessionTranscriptIndexing",
      path: ["memory", "denySessionTranscriptIndexing"],
    }),
  ].filter((finding): finding is HealthFinding => finding !== undefined);
}

function policySectionUnsupportedKeyFinding(
  value: Record<string, unknown>,
  params: {
    readonly policyPath: string;
    readonly policyDocName: string;
    readonly propertyPath: string;
    readonly targetPath: string;
    readonly sectionName: string;
    readonly allowedKeys: readonly string[];
  },
): HealthFinding | undefined {
  const unsupportedKey = unsupportedPolicyKey(value, params.allowedKeys);
  if (unsupportedKey === undefined) {
    return undefined;
  }
  return policyShapeFinding(
    params.policyPath,
    `oc://${params.policyDocName}/${params.targetPath}/${ocPathSegment(unsupportedKey)}`,
    `${params.policyPath} ${params.propertyPath}.${unsupportedKey} is not supported in ${params.sectionName} policy.`,
    `Remove ${params.propertyPath}.${unsupportedKey} or use a supported ${params.sectionName} policy rule.`,
  );
}

function dataHandlingSectionShapeFinding(
  dataHandling: Record<string, unknown>,
  params: {
    readonly policyPath: string;
    readonly policyDocName: string;
    readonly propertyPath: string;
    readonly targetPath: string;
    readonly section: string;
  },
): HealthFinding | undefined {
  const value = dataHandling[params.section];
  if (value === undefined || isRecord(value)) {
    return undefined;
  }
  return policyShapeFinding(
    params.policyPath,
    `oc://${params.policyDocName}/${params.targetPath}`,
    `${params.policyPath} ${params.propertyPath} must be an object.`,
    `Fix ${params.propertyPath} so it contains boolean policy rules.`,
  );
}

function dataHandlingBooleanShapeFinding(
  dataHandling: unknown,
  params: {
    readonly policyPath: string;
    readonly policyDocName: string;
    readonly propertyPath: string;
    readonly targetPath: string;
    readonly path: readonly string[];
  },
): HealthFinding | undefined {
  const value = getPolicyPath(dataHandling, params.path);
  if (isRecord(dataHandling) && typeof params.path[0] === "string") {
    const section = dataHandling[params.path[0]];
    if (isRecord(section) && typeof params.path[1] === "string") {
      const sectionPath = params.path.slice(0, -1).join(".");
      const unsupportedKey = unsupportedPolicyKey(section, [params.path[1]]);
      if (unsupportedKey !== undefined) {
        return policyShapeFinding(
          params.policyPath,
          `oc://${params.policyDocName}/${params.targetPath
            .split("/")
            .slice(0, -1)
            .join("/")}/${ocPathSegment(unsupportedKey)}`,
          `${params.policyPath} dataHandling.${sectionPath}.${unsupportedKey} is not supported in data-handling policy.`,
          `Remove dataHandling.${sectionPath}.${unsupportedKey} or use ${params.propertyPath}.`,
        );
      }
    }
  }
  if (value === undefined || typeof value === "boolean") {
    return undefined;
  }
  return policyShapeFinding(
    params.policyPath,
    `oc://${params.policyDocName}/${params.targetPath}`,
    `${params.policyPath} ${params.propertyPath} must be a boolean.`,
    `Set ${params.propertyPath} to true or false.`,
  );
}

export function dataHandlingEntries(
  evidence: PolicyEvidence,
  kind: PolicyDataHandlingEvidence["kind"],
): readonly PolicyDataHandlingEvidence[] {
  return (evidence.dataHandling ?? []).filter((entry) => entry.kind === kind);
}

export function dataHandlingFinding(
  entry: PolicyDataHandlingEvidence,
  params: {
    readonly checkId: (typeof POLICY_CHECK_IDS)[number];
    readonly message: string;
    readonly requirement: string;
    readonly fixHint: string;
  },
): HealthFinding {
  return {
    checkId: params.checkId,
    severity: "error",
    message: params.message,
    source: "policy",
    path: "openclaw config",
    ocPath: entry.source,
    target: entry.source,
    requirement: params.requirement,
    fixHint: params.fixHint,
  };
}

export function dataHandlingLabel(entry: PolicyDataHandlingEvidence): string {
  return entry.agentId === undefined ? "Global data handling config" : `agent '${entry.agentId}'`;
}

export function secretPolicyShapeFindings(
  policy: unknown,
  policyPath: string,
  policyDocName: string,
): readonly HealthFinding[] {
  if (!isRecord(policy) || !isRecord(policy.secrets)) {
    return [];
  }
  const findings: HealthFinding[] = [];
  for (const key of ["requireManagedProviders", "allowInsecureProviders"] as const) {
    if (policy.secrets[key] !== undefined && typeof policy.secrets[key] !== "boolean") {
      findings.push(
        policyShapeFinding(
          policyPath,
          `oc://${policyDocName}/secrets/${key}`,
          `${policyPath} secrets.${key} must be a boolean.`,
          `Set secrets.${key} to true or false.`,
        ),
      );
    }
  }
  if (policy.secrets.denySources !== undefined && !Array.isArray(policy.secrets.denySources)) {
    findings.push(
      policyShapeFinding(
        policyPath,
        `oc://${policyDocName}/secrets/denySources`,
        `${policyPath} secrets.denySources must be an array of source names.`,
        'Use an array such as ["exec"] or remove secrets.denySources.',
      ),
    );
  } else if (Array.isArray(policy.secrets.denySources)) {
    const invalidIndex = policy.secrets.denySources.findIndex(
      (entry) => typeof entry !== "string" || entry.trim() === "",
    );
    if (invalidIndex >= 0) {
      findings.push(
        policyShapeFinding(
          policyPath,
          `oc://${policyDocName}/secrets/denySources/#${invalidIndex}`,
          `${policyPath} secrets.denySources[${invalidIndex}] must be a non-empty source name.`,
          "Use non-empty source names such as env, file, exec, or openclaw.",
        ),
      );
    }
  }
  return findings;
}

export function authProfileAllowModesShapeFindings(
  policy: unknown,
  policyPath: string,
  policyDocName: string,
): readonly HealthFinding[] {
  if (
    !isRecord(policy) ||
    !isRecord(policy.auth) ||
    !isRecord(policy.auth.profiles) ||
    policy.auth.profiles.allowModes === undefined
  ) {
    return [];
  }
  if (!Array.isArray(policy.auth.profiles.allowModes)) {
    return [
      policyShapeFinding(
        policyPath,
        `oc://${policyDocName}/auth/profiles/allowModes`,
        `${policyPath} auth.profiles.allowModes must be an array of auth modes.`,
        `Use supported auth modes: ${SUPPORTED_AUTH_PROFILE_MODES.join(", ")}.`,
      ),
    ];
  }
  const invalidIndex = policy.auth.profiles.allowModes.findIndex(
    (entry) =>
      typeof entry !== "string" ||
      !SUPPORTED_AUTH_PROFILE_MODES.includes(
        entry.trim().toLowerCase() as (typeof SUPPORTED_AUTH_PROFILE_MODES)[number],
      ),
  );
  if (invalidIndex < 0) {
    return [];
  }
  return [
    policyShapeFinding(
      policyPath,
      `oc://${policyDocName}/auth/profiles/allowModes/#${invalidIndex}`,
      `${policyPath} auth.profiles.allowModes[${invalidIndex}] must be a supported auth mode.`,
      `Use supported auth modes: ${SUPPORTED_AUTH_PROFILE_MODES.join(", ")}.`,
    ),
  ];
}
