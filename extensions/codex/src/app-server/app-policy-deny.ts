/**
 * Applies host-certified `mcp__codex_apps__<literal>*` denies to the apps
 * OpenClaw admits into a native Codex thread.
 */
import { readCodexAppToolsByConnector } from "./app-tool-inventory.js";
import {
  resolveCodexAppModelToolNamesByConnector,
  type CodexAppModelTools,
} from "./codex-app-tool-names.js";
import type { ResolvedCodexPluginPolicy } from "./config.js";

/** Model-facing prefix Codex gives every shared `codex_apps` tool. */
export const CODEX_APPS_TOOL_NAME_PREFIX = "mcp__codex_apps__";

type CodexAppDenyDecision = "allowed" | "denied" | "unenforceable";

/** Diagnostic emitted when tool policy removes or cannot safely scope a Codex app. */
export type CodexAppDenyDiagnostic = {
  code: "app_denied_by_policy" | "app_policy_unenforceable";
  plugin?: ResolvedCodexPluginPolicy;
  message: string;
};

function buildCodexAppDeniedDiagnostic(
  appId: string,
  plugin?: ResolvedCodexPluginPolicy,
): CodexAppDenyDiagnostic {
  return {
    code: "app_denied_by_policy",
    ...(plugin ? { plugin } : {}),
    message: `${appId} is denied by tool policy.`,
  };
}

export function buildCodexAppDenyUnenforceableDiagnostic(appId: string): CodexAppDenyDiagnostic {
  return {
    code: "app_policy_unenforceable",
    message: `Tool policy could not be applied to every tool of Codex app ${appId}; Codex apps were disabled for this turn. Deny the whole app (${CODEX_APPS_TOOL_NAME_PREFIX}<app>_*) or allow it.`,
  };
}

export function buildCodexAppDenyUnmanagedDiagnostic(
  patterns: readonly string[],
): CodexAppDenyDiagnostic {
  return {
    code: "app_policy_unenforceable",
    message: `Tool policy denies ${patterns.join(", ")} but codexPlugins is not enabled, so OpenClaw cannot admit apps selectively; Codex apps were disabled for this turn. Enable codexPlugins with allow_all_plugins to scope apps per agent.`,
  };
}

export function buildCodexAppDenyUnmatchedDiagnostic(
  patterns: readonly string[],
): CodexAppDenyDiagnostic {
  return {
    code: "app_policy_unenforceable",
    message: `Tool policy denies ${patterns.join(", ")} but no connected Codex app exposes a matching tool; Codex apps were disabled for this turn. Check the app namespace in the tool names Codex exposes, or remove the deny.`,
  };
}

/** Lowercases, dedupes, and sorts patterns so fingerprints and decisions agree. */
export function normalizeCodexDeniedAppPatterns(patterns: readonly string[] | undefined): string[] {
  if (!patterns?.length) {
    return [];
  }
  return [
    ...new Set(
      patterns
        .map((pattern) => pattern.trim().toLowerCase())
        .filter(
          (pattern) =>
            pattern.startsWith(CODEX_APPS_TOOL_NAME_PREFIX) &&
            pattern.endsWith("*") &&
            !/[*?]/.test(pattern.slice(CODEX_APPS_TOOL_NAME_PREFIX.length, -1)),
        ),
    ),
  ].toSorted();
}

/**
 * Reads the app tool inventory only when denies need it and resolves the
 * model-visible name of every tool the way Codex does. An unreadable inventory
 * yields undefined so every gated app fails closed.
 */
export async function readCodexAppModelToolsForDenies(params: {
  request: (method: string, params: Record<string, unknown>) => Promise<unknown>;
  threadId?: string;
  patterns: readonly string[];
}): Promise<ReadonlyMap<string, CodexAppModelTools> | undefined> {
  if (params.patterns.length === 0) {
    return new Map();
  }
  return await readCodexAppToolsByConnector(params)
    .then(resolveCodexAppModelToolNamesByConnector)
    .catch(() => undefined);
}

/**
 * A pattern whose literal is the app namespace, a prefix of it (including the
 * global `mcp__codex_apps__*`), or the namespace plus `_` denies the whole app,
 * whatever callable names its tools carry and even when Codex hides every tool
 * from the model. Codex appends a callable name to the namespace with no
 * separator, so a tool whose raw name lacks the connector prefix
 * (`capture_file_upload` under `Gmail` becomes
 * `mcp__codex_apps__gmailcapture_file_upload`) would otherwise escape the
 * advertised `<app>_*` form.
 */
function patternCoversWholeApp(pattern: string, namespaces: readonly string[]): boolean {
  const literal = pattern.slice(0, -1);
  // The global deny covers every app, including one whose tools carry a
  // connector id but no connector name and so sit under the bare `mcp__codex_apps`.
  if (literal === CODEX_APPS_TOOL_NAME_PREFIX) {
    return true;
  }
  return namespaces.some(
    (namespace) => namespace.startsWith(literal) || literal === `${namespace}_`,
  );
}

/**
 * Returns the patterns that match no known app namespace or tool. Codex does not
 * expose model-facing app tool names over the protocol, so a deny that matches
 * nothing may be a misspelling or a naming change; either way it must not be
 * treated as satisfied.
 */
function findUnmatchedCodexAppDenyPatterns(params: {
  modelToolsByApp: ReadonlyMap<string, CodexAppModelTools>;
  patterns: readonly string[];
}): string[] {
  const apps = [...params.modelToolsByApp.values()];
  const modelToolNames = apps.flatMap((app) => app.modelToolNames);
  return params.patterns.filter((pattern) => {
    const literal = pattern.slice(0, -1);
    return (
      !apps.some((app) => patternCoversWholeApp(pattern, app.namespaces)) &&
      !modelToolNames.some((modelToolName) => modelToolName.startsWith(literal))
    );
  });
}

/**
 * Decides whether the patterns deny one app. A whole-app pattern, or patterns
 * covering every model-visible tool, deny the app; patterns covering only some
 * tools have no projectable form and fail closed, as does an app whose tools
 * could not be read. Tools Codex hides from the model do not count.
 */
function resolveCodexAppDenyDecision(params: {
  app: CodexAppModelTools | undefined;
  patterns: readonly string[];
}): CodexAppDenyDecision {
  if (params.patterns.length === 0) {
    return "allowed";
  }
  if (!params.app) {
    return "unenforceable";
  }
  if (params.patterns.some((pattern) => patternCoversWholeApp(pattern, params.app!.namespaces))) {
    return "denied";
  }
  const literals = params.patterns.map((pattern) => pattern.slice(0, -1));
  const matched = params.app.modelToolNames.filter((modelToolName) =>
    literals.some((literal) => modelToolName.startsWith(literal)),
  ).length;
  if (matched === 0) {
    return "allowed";
  }
  return matched === params.app.modelToolNames.length ? "denied" : "unenforceable";
}

/**
 * Builds the per-app gate a thread config build runs before admitting an app.
 * `apply` returns false to admit, true to skip a denied app (recording a
 * diagnostic), or the caller's fail-closed config when the deny cannot be applied
 * exactly. `unmatched` lists patterns that touch no known app tool.
 */
export function createCodexAppDenyGate<T>(params: {
  modelToolsByApp: ReadonlyMap<string, CodexAppModelTools> | undefined;
  patterns: readonly string[];
  onDenied: (diagnostic: CodexAppDenyDiagnostic) => void;
  failClosed: (appId: string) => T;
}): {
  apply: (appId: string, plugin?: ResolvedCodexPluginPolicy) => T | boolean;
  unmatched: string[];
} {
  return {
    unmatched: params.modelToolsByApp
      ? findUnmatchedCodexAppDenyPatterns({
          modelToolsByApp: params.modelToolsByApp,
          patterns: params.patterns,
        })
      : [],
    apply: (appId, plugin) => {
      const decision = resolveCodexAppDenyDecision({
        app: params.modelToolsByApp?.get(appId),
        patterns: params.patterns,
      });
      if (decision === "denied") {
        params.onDenied(buildCodexAppDeniedDiagnostic(appId, plugin));
      }
      return decision === "unenforceable" ? params.failClosed(appId) : decision === "denied";
    },
  };
}
