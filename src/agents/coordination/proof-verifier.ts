export const COORDINATION_REQUIRED_PROOF_MARKERS = [
  "agentExecBootstrapContext_resolved",
  "ensureCliCommandBootstrap_before_plugin_policy_decision",
  "ensureCliCommandBootstrap_skip_plugin_registry_coordination_only",
  "ensureCliCommandBootstrap_after_plugin_policy_decision",
  "action_handler_expected",
  "direct_agent_command_internal_enter",
  "direct_before_prepareAgentCommandExecution",
  "direct_prepare_enter",
  "direct_after_resolveAgentRuntimeConfig",
  "direct_before_workspace_dir_derivation",
  "direct_after_workspace_dir_derivation",
  "direct_before_ensureAgentWorkspace",
  "direct_ensureAgentWorkspace_enter",
  "direct_workspace_path_resolved",
  "direct_workspace_before_mkdir",
  "direct_workspace_after_mkdir",
  "direct_ensureAgentWorkspace_finally",
  "direct_before_standard_attempt_branch",
] as const;

export const COORDINATION_FORBIDDEN_PROOF_MARKERS = [
  "ensureCliPluginRegistryLoaded_enter",
  "ensureCliPluginRegistryLoaded_before_dynamic_import",
  "ensurePluginRegistryLoaded_enter",
  "channelEntry_register_enter",
  "channelEntry_setChannelRuntime_enter",
] as const;

export type CoordinationProofMarker = string;

export type CoordinationProofEvent = {
  event?: unknown;
  marker?: unknown;
  modulePath?: unknown;
  selectedModulePath?: unknown;
  resolvedPath?: unknown;
  callStack?: unknown;
  callStackFamily?: unknown;
  stack?: unknown;
  reason?: unknown;
  source?: unknown;
  phase?: unknown;
  timestamp?: unknown;
  [key: string]: unknown;
};

export type CoordinationBundledEntryExportFinding = {
  status: "allowed" | "fail" | "blocked";
  marker: "bundledEntryExport_before_module_load";
  modulePath?: string;
  callStackFamily?: string;
  reason: string;
};

export type CoordinationProofVerificationResult = {
  status: "pass" | "fail" | "blocked";
  requiredMarkersPresent: string[];
  requiredMarkersMissing: string[];
  forbiddenMarkersFound: string[];
  bundledEntryExportFindings: CoordinationBundledEntryExportFinding[];
  classificationReason: string;
};

export function verifyCoordinationProofMarkers(
  input: unknown,
): CoordinationProofVerificationResult {
  if (!Array.isArray(input) || input.length === 0) {
    return blockedResult({
      requiredMarkersPresent: [],
      requiredMarkersMissing: [...COORDINATION_REQUIRED_PROOF_MARKERS],
      forbiddenMarkersFound: [],
      bundledEntryExportFindings: [],
      classificationReason: "Proof marker input is empty or not an array",
    });
  }

  const parsedEvents: { marker: string; raw: CoordinationProofEvent }[] = [];
  for (let index = 0; index < input.length; index += 1) {
    const entry = input[index];
    if (typeof entry === "string") {
      if (entry.length === 0) {
        return blockedResult({
          requiredMarkersPresent: [],
          requiredMarkersMissing: [...COORDINATION_REQUIRED_PROOF_MARKERS],
          forbiddenMarkersFound: [],
          bundledEntryExportFindings: [],
          classificationReason: `Marker at input[${index}] is empty`,
        });
      }
      parsedEvents.push({ marker: entry, raw: { marker: entry } });
      continue;
    }
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return blockedResult({
        requiredMarkersPresent: [],
        requiredMarkersMissing: [...COORDINATION_REQUIRED_PROOF_MARKERS],
        forbiddenMarkersFound: [],
        bundledEntryExportFindings: [],
        classificationReason: `Malformed debug event at input[${index}]`,
      });
    }
    const marker = extractMarker(entry);
    if (!marker) {
      return blockedResult({
        requiredMarkersPresent: [],
        requiredMarkersMissing: [...COORDINATION_REQUIRED_PROOF_MARKERS],
        forbiddenMarkersFound: [],
        bundledEntryExportFindings: [],
        classificationReason: `Marker name could not be extracted reliably at input[${index}]`,
      });
    }
    parsedEvents.push({ marker, raw: entry });
  }

  const presentMarkers = new Set(parsedEvents.map((entry) => entry.marker));
  const requiredMarkersPresent = COORDINATION_REQUIRED_PROOF_MARKERS.filter((marker) =>
    presentMarkers.has(marker),
  );
  const requiredMarkersMissing = COORDINATION_REQUIRED_PROOF_MARKERS.filter(
    (marker) => !presentMarkers.has(marker),
  );
  const forbiddenMarkersFound = COORDINATION_FORBIDDEN_PROOF_MARKERS.filter((marker) =>
    presentMarkers.has(marker),
  );

  if (forbiddenMarkersFound.length > 0) {
    return {
      status: "fail",
      requiredMarkersPresent: [...requiredMarkersPresent],
      requiredMarkersMissing: [...requiredMarkersMissing],
      forbiddenMarkersFound: [...forbiddenMarkersFound],
      bundledEntryExportFindings: [],
      classificationReason: `Forbidden marker found: ${forbiddenMarkersFound[0]}`,
    };
  }

  const forbiddenPluginLoadMarkers = parsedEvents.filter(
    (entry) =>
      entry.marker === "loadOpenClawPlugins_enter" ||
      entry.marker === "loadOpenClawPlugins_before_candidate_module_load" ||
      entry.marker === "loadOpenClawPlugins_before_candidate_register",
  );
  for (const finding of forbiddenPluginLoadMarkers) {
    if (
      isPluginBootstrapRelated(finding.raw) ||
      isExplicitForbiddenPluginLoadPhase(finding.marker)
    ) {
      return {
        status: "fail",
        requiredMarkersPresent: [...requiredMarkersPresent],
        requiredMarkersMissing: [...requiredMarkersMissing],
        forbiddenMarkersFound: [finding.marker],
        bundledEntryExportFindings: [],
        classificationReason: `Plugin-bootstrap-path ${finding.marker} was found`,
      };
    }
  }

  const bundledEntryExportFindings = parsedEvents
    .filter((entry) => entry.marker === "bundledEntryExport_before_module_load")
    .map((entry) => classifyBundledEntryExportFinding(entry.raw));

  const failingBundledEntry = bundledEntryExportFindings.find(
    (finding) => finding.status === "fail",
  );
  if (failingBundledEntry) {
    return {
      status: "fail",
      requiredMarkersPresent: [...requiredMarkersPresent],
      requiredMarkersMissing: [...requiredMarkersMissing],
      forbiddenMarkersFound: [],
      bundledEntryExportFindings,
      classificationReason: failingBundledEntry.reason,
    };
  }

  const blockedBundledEntry = bundledEntryExportFindings.find(
    (finding) => finding.status === "blocked",
  );
  if (blockedBundledEntry) {
    return {
      status: "blocked",
      requiredMarkersPresent: [...requiredMarkersPresent],
      requiredMarkersMissing: [...requiredMarkersMissing],
      forbiddenMarkersFound: [],
      bundledEntryExportFindings,
      classificationReason: blockedBundledEntry.reason,
    };
  }

  if (requiredMarkersMissing.length > 0) {
    return blockedResult({
      requiredMarkersPresent: [...requiredMarkersPresent],
      requiredMarkersMissing: [...requiredMarkersMissing],
      forbiddenMarkersFound: [],
      bundledEntryExportFindings,
      classificationReason: `Required marker missing: ${requiredMarkersMissing[0]}`,
    });
  }

  return {
    status: "pass",
    requiredMarkersPresent: [...requiredMarkersPresent],
    requiredMarkersMissing: [],
    forbiddenMarkersFound: [],
    bundledEntryExportFindings,
    classificationReason:
      "All required markers were present, no forbidden markers were found, and scoped bundled entry findings were allowed or absent",
  };
}

function blockedResult(
  params: Omit<CoordinationProofVerificationResult, "status">,
): CoordinationProofVerificationResult {
  return {
    status: "blocked",
    ...params,
  };
}

function extractMarker(event: CoordinationProofEvent): string | undefined {
  if (typeof event.event === "string" && event.event.length > 0) {
    return event.event;
  }
  if (typeof event.marker === "string" && event.marker.length > 0) {
    return event.marker;
  }
  const nestedSource = extractNestedSourceEvent(event.source);
  if (typeof nestedSource?.event === "string" && nestedSource.event.length > 0) {
    return nestedSource.event;
  }
  return undefined;
}

function extractNestedSourceEvent(
  source: unknown,
): { source?: string; event?: string; data?: Record<string, unknown> } | undefined {
  if (typeof source !== "object" || source === null || Array.isArray(source)) {
    return undefined;
  }
  const candidate = source as { source?: unknown; event?: unknown; data?: unknown };
  const nested: { source?: string; event?: string; data?: Record<string, unknown> } = {};
  if (typeof candidate.source === "string" && candidate.source.length > 0) {
    nested.source = candidate.source;
  }
  if (typeof candidate.event === "string" && candidate.event.length > 0) {
    nested.event = candidate.event;
  }
  if (
    typeof candidate.data === "object" &&
    candidate.data !== null &&
    !Array.isArray(candidate.data)
  ) {
    nested.data = candidate.data as Record<string, unknown>;
  }
  return nested.source || nested.event || nested.data ? nested : undefined;
}

function classifyBundledEntryExportFinding(
  raw: CoordinationProofEvent,
): CoordinationBundledEntryExportFinding {
  const modulePath = firstDefinedString(raw.selectedModulePath, raw.modulePath, raw.resolvedPath);
  const callStackFamily = firstDefinedString(raw.callStackFamily, raw.callStack, raw.stack);
  const marker = "bundledEntryExport_before_module_load" as const;

  const pluginBootstrapRelated = isPluginBootstrapRelated(raw);
  const slackRegisterOrRuntimeSetterRelated = isSlackRegisterOrRuntimeSetterRelated(raw);
  const slackRelated = isSlackRelated(raw, modulePath, callStackFamily);
  const channelPluginApiRelated =
    typeof modulePath === "string" && modulePath.includes("channel-plugin-api.js");

  if (pluginBootstrapRelated) {
    return {
      status: "fail",
      marker,
      modulePath,
      callStackFamily,
      reason:
        "bundledEntryExport_before_module_load was attributed to the forbidden plugin-bootstrap path",
    };
  }

  if (slackRegisterOrRuntimeSetterRelated) {
    return {
      status: "fail",
      marker,
      modulePath,
      callStackFamily,
      reason:
        "bundledEntryExport_before_module_load was attributed to forbidden Slack register/runtime-setter execution",
    };
  }

  if (slackRelated && channelPluginApiRelated) {
    return {
      status: "allowed",
      marker,
      modulePath,
      callStackFamily,
      reason:
        "bundledEntryExport_before_module_load was Slack-related but scoped to channel-plugin-api loading and not attributed to plugin-bootstrap or Slack register/runtime-setter execution",
    };
  }

  return {
    status: "blocked",
    marker,
    modulePath,
    callStackFamily,
    reason:
      "bundledEntryExport_before_module_load existed but evidence was insufficient to classify it safely as allowed or forbidden",
  };
}

function isPluginBootstrapRelated(raw: CoordinationProofEvent): boolean {
  return containsAnyKeyword(
    [raw.reason, raw.source, raw.phase, raw.callStackFamily, raw.callStack, raw.stack],
    [
      "plugin-bootstrap",
      "ensurePluginRegistryLoaded",
      "ensureCliPluginRegistryLoaded",
      "loadOpenClawPlugins",
      "runPluginRegisterSync",
    ],
  );
}

function isSlackRegisterOrRuntimeSetterRelated(raw: CoordinationProofEvent): boolean {
  return containsAnyKeyword(
    [raw.reason, raw.source, raw.phase, raw.callStackFamily, raw.callStack, raw.stack],
    [
      "channelEntry_register",
      "channelEntry_setChannelRuntime",
      "setChannelRuntime",
      "setSlackRuntime",
      "runtime setter",
      "registerSlackPluginHttpRoutes",
    ],
  );
}

function isSlackRelated(
  raw: CoordinationProofEvent,
  modulePath?: string,
  callStackFamily?: string,
): boolean {
  return containsAnyKeyword(
    [modulePath, callStackFamily, raw.reason, raw.source, raw.phase],
    ["slack"],
  );
}

function firstDefinedString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return undefined;
}

function isExplicitForbiddenPluginLoadPhase(marker: string): boolean {
  return (
    marker === "loadOpenClawPlugins_enter" ||
    marker === "loadOpenClawPlugins_before_candidate_module_load" ||
    marker === "loadOpenClawPlugins_before_candidate_register"
  );
}

function containsAnyKeyword(values: unknown[], keywords: string[]): boolean {
  const normalized = values
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .join("\n")
    .toLowerCase();
  if (normalized.length === 0) {
    return false;
  }
  return keywords.some((keyword) => normalized.includes(keyword.toLowerCase()));
}
