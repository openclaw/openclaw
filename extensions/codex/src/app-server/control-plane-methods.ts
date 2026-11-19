const CONTROL_PLANE_METHODS = new Set([
  "account/rateLimits/read",
  "account/read",
  "app/installed",
  "app/list",
  "app/read",
  "config/batchWrite",
  "config/mcpServer/reload",
  "config/read",
  "config/value/write",
  "environment/add",
  "experimentalFeature/list",
  "experimentalFeature/enablement/set",
  "feedback/upload",
  "hooks/list",
  "initialize",
  "marketplace/add",
  "mcpServerStatus/list",
  "model/list",
  "plugin/install",
  "plugin/installed",
  "plugin/list",
  "plugin/read",
  "skills/list",
  "thread/archive",
  "thread/inject_items",
  "thread/list",
  "thread/metadata/update",
  "thread/name/set",
  "thread/read",
  "thread/rollback",
  "thread/unarchive",
  "thread/unsubscribe",
  "turn/interrupt",
  "turn/steer",
]);

export function isCodexControlPlaneMethod(method: string): boolean {
  return CONTROL_PLANE_METHODS.has(method);
}

export function isCodexPolicyFreeControlPlaneMethod(method: string): boolean {
  // MCP reload can start app-backed processes and still needs node-exec policy.
  return isCodexControlPlaneMethod(method) && method !== "config/mcpServer/reload";
}
