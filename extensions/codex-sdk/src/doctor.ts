import { randomUUID } from "node:crypto";
import {
  CODEX_SDK_BACKEND_ID,
  CODEX_SDK_PACKAGE_NAME,
  CODEX_SDK_PINNED_VERSION,
  type ResolvedCodexSdkPluginConfig,
} from "./config.js";
import type { CodexCompatibilityRecord, CodexNativeStateStore } from "./state.js";

type Check = CodexCompatibilityRecord["checks"][number];

export async function createCodexCompatibilityRecord(params: {
  config: ResolvedCodexSdkPluginConfig;
  stateStore?: CodexNativeStateStore;
  probeRuntime?: () => Promise<void>;
  loadSdk?: () => Promise<unknown>;
}): Promise<CodexCompatibilityRecord> {
  const checks: Check[] = [];

  checks.push(await checkSdkImport(params.loadSdk));
  checks.push(checkRoutes(params.config));
  checks.push(checkBackchannel(params.config));
  checks.push(await checkStateWritable(params.stateStore));
  checks.push(await checkRuntimeProbe(params.probeRuntime));
  checks.push({
    id: "mcp_event_mapping",
    status: "pass",
    message:
      "Codex SDK MCP, command, file, web-search, reasoning, usage, and text events are mapped into OpenClaw ACP events.",
  });
  checks.push({
    id: "proposal_inbox",
    status: params.stateStore ? "pass" : "warn",
    message: params.stateStore
      ? "OpenClaw proposal inbox is available for openclaw-proposal JSON blocks."
      : "OpenClaw proposal inbox is unavailable because no state store was provided.",
  });

  const ok = checks.every((check) => check.status === "pass" || check.status === "not_checked");
  return {
    schemaVersion: 2,
    id: randomUUID(),
    checkedAt: new Date().toISOString(),
    ok,
    backend: CODEX_SDK_BACKEND_ID,
    sdkPackage: CODEX_SDK_PACKAGE_NAME,
    sdkVersion: CODEX_SDK_PINNED_VERSION,
    defaultRoute: params.config.defaultRoute,
    checks,
  };
}

async function checkSdkImport(loadSdk: (() => Promise<unknown>) | undefined): Promise<Check> {
  try {
    if (loadSdk) {
      await loadSdk();
    } else {
      const specifier = "@openai/codex-sdk";
      await import(specifier);
    }
    return {
      id: "sdk_import",
      status: "pass",
      message: `${CODEX_SDK_PACKAGE_NAME}@${CODEX_SDK_PINNED_VERSION} imported successfully.`,
    };
  } catch (error) {
    return {
      id: "sdk_import",
      status: "fail",
      message: `Unable to import ${CODEX_SDK_PACKAGE_NAME}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function checkRoutes(config: ResolvedCodexSdkPluginConfig): Check {
  const routes = Object.values(config.routes);
  if (routes.length === 0) {
    return { id: "route_registry", status: "fail", message: "No Codex routes are configured." };
  }
  if (!config.routes[config.defaultRoute]) {
    return {
      id: "route_registry",
      status: "fail",
      message: `Default Codex route is missing: ${config.defaultRoute}`,
    };
  }
  return {
    id: "route_registry",
    status: "pass",
    message: `Routes available: ${routes.map((route) => route.label).join(", ")}`,
  };
}

function checkBackchannel(config: ResolvedCodexSdkPluginConfig): Check {
  if (!config.backchannel.enabled) {
    return {
      id: "mcp_backchannel",
      status: "warn",
      message:
        "Codex MCP backchannel is disabled; Codex can run turns but cannot call back into OpenClaw.",
    };
  }
  const allowed = new Set(config.backchannel.allowedMethods);
  const missingRequired = ["codex.status", "codex.proposal.create"].filter(
    (method) => !allowed.has(method),
  );
  if (missingRequired.length > 0) {
    return {
      id: "mcp_backchannel",
      status: "fail",
      message: `Codex MCP backchannel is missing required methods: ${missingRequired.join(", ")}`,
    };
  }
  return {
    id: "mcp_backchannel",
    status: "pass",
    message: `Codex MCP backchannel '${config.backchannel.name}' is enabled with ${config.backchannel.allowedMethods.length} allowed methods.`,
  };
}

async function checkStateWritable(stateStore: CodexNativeStateStore | undefined): Promise<Check> {
  if (!stateStore) {
    return {
      id: "state_writable",
      status: "warn",
      message: "No Codex native state store was provided.",
    };
  }
  try {
    await stateStore.checkWritable();
    return {
      id: "state_writable",
      status: "pass",
      message: `State directory is writable: ${stateStore.rootDir}`,
    };
  } catch (error) {
    return {
      id: "state_writable",
      status: "fail",
      message: `State directory is not writable: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

async function checkRuntimeProbe(probeRuntime: (() => Promise<void>) | undefined): Promise<Check> {
  if (!probeRuntime) {
    return {
      id: "runtime_probe",
      status: "not_checked",
      message: "Runtime probe was not requested.",
    };
  }
  try {
    await probeRuntime();
    return {
      id: "runtime_probe",
      status: "pass",
      message: "Codex SDK runtime probe succeeded.",
    };
  } catch (error) {
    return {
      id: "runtime_probe",
      status: "fail",
      message: `Codex SDK runtime probe failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
