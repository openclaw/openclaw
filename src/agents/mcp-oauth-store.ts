// Canonical MCP OAuth session state. Legacy JSON import belongs to doctor only.
import { executeExistingOpenClawStateRead } from "../state/openclaw-state-db-readonly.js";
import type { OpenClawStateAsyncLeaseContext } from "../state/openclaw-state-lease.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import type { OpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.types.js";
import {
  executeOpenClawStateWorker,
  runWithOpenClawStateLeaseWorker,
} from "../state/openclaw-state-worker-store.js";
import {
  projectMcpOAuthCredentialsStatus,
  type McpOAuthPrincipalStatus,
} from "./mcp-oauth-status.js";
import type { McpOAuthMutation, McpOAuthStore } from "./mcp-oauth-store.types.js";
export { parseMcpOAuthStoreJson } from "./mcp-oauth-store.kernel.js";
export type { McpOAuthStore } from "./mcp-oauth-store.types.js";

/** Read canonical state, opening the writable lifecycle when runtime owns it. */
export async function readMcpOAuthStore(
  storeKey: string,
  context: OpenClawStateWorkerContext = captureOpenClawStateWorkerContext(),
): Promise<McpOAuthStore> {
  return executeOpenClawStateWorker(context, { type: "mcpOAuth.read", input: storeKey });
}

/** Read status state without creating or repairing the shared database. */
export async function readMcpOAuthStoreReadOnly(
  storeKey: string,
  context: OpenClawStateWorkerContext = captureOpenClawStateWorkerContext(),
): Promise<McpOAuthStore> {
  const result = await executeExistingOpenClawStateRead(
    { path: context.admission.databasePath, env: context.environment },
    { type: "mcpOAuth.readOnly", input: storeKey },
    { context },
  );
  if (result === undefined) {
    return {};
  }
  if (result.ok && result.type === "mcpOAuth.readOnly") {
    return result.value;
  }
  throw new Error("Unexpected MCP OAuth store read result");
}

export async function readMcpOAuthStoreStatuses(
  storeKeys: readonly string[],
  context: OpenClawStateWorkerContext = captureOpenClawStateWorkerContext(),
): Promise<McpOAuthPrincipalStatus[]> {
  if (storeKeys.length === 0) {
    return [];
  }
  const result = await executeExistingOpenClawStateRead(
    { path: context.admission.databasePath, env: context.environment },
    { type: "mcpOAuth.statuses", input: storeKeys },
    { context },
  );
  if (result === undefined) {
    return storeKeys.map(() => projectMcpOAuthCredentialsStatus({}));
  }
  if (result.ok && result.type === "mcpOAuth.statuses") {
    return result.value;
  }
  throw new Error("Unexpected MCP OAuth status batch result");
}

/** List canonical store keys matching one server/principal prefix without creating state. */
export async function listMcpOAuthStoreKeysByPrefix(
  prefix: string,
  context: OpenClawStateWorkerContext = captureOpenClawStateWorkerContext(),
): Promise<string[]> {
  const result = await executeExistingOpenClawStateRead(
    { path: context.admission.databasePath, env: context.environment },
    { type: "mcpOAuth.keys", input: prefix },
    { context },
  );
  if (result === undefined) {
    return [];
  }
  if (result.ok && result.type === "mcpOAuth.keys") {
    return result.value;
  }
  throw new Error("Unexpected MCP OAuth keys read result");
}

export async function countMcpOAuthStorePrincipals(prefix: string): Promise<number> {
  const context = captureOpenClawStateWorkerContext();
  const result = await executeExistingOpenClawStateRead(
    { path: context.admission.databasePath, env: context.environment },
    { type: "mcpOAuth.countPrincipals", input: prefix },
    { context },
  );
  if (result === undefined) {
    return 0;
  }
  if (result.ok && result.type === "mcpOAuth.countPrincipals") {
    return result.value;
  }
  throw new Error("Unexpected MCP OAuth principal count result");
}

/** Resolve one unexpired callback state without creating state or scanning credential JSON. */
export async function readMcpOAuthPendingAuthorization(
  state: string,
  context: OpenClawStateWorkerContext = captureOpenClawStateWorkerContext(),
): Promise<string | undefined> {
  const result = await executeExistingOpenClawStateRead(
    { path: context.admission.databasePath, env: context.environment },
    { type: "mcpOAuth.pending", input: state },
    { context },
  );
  if (result === undefined) {
    return undefined;
  }
  if (result.ok && result.type === "mcpOAuth.pending") {
    return result.value;
  }
  throw new Error("Unexpected MCP OAuth pending state read result");
}

/** Apply one typed OAuth operation to a fresh snapshot under the live lease. */
export function mutateMcpOAuthStore(
  storeKey: string,
  mutation: McpOAuthMutation,
  lease: OpenClawStateAsyncLeaseContext,
  context: OpenClawStateWorkerContext,
): Promise<{ store: McpOAuthStore; applied: boolean }> {
  return runWithOpenClawStateLeaseWorker(lease, context, (scope, identity) =>
    scope.execute({ type: "mcpOAuth.mutate", input: { storeKey, mutation, identity } }),
  );
}

export function consumeOAuthState(
  storeKey: string,
  state: string,
  lease: OpenClawStateAsyncLeaseContext,
  context: OpenClawStateWorkerContext,
): Promise<boolean> {
  return runWithOpenClawStateLeaseWorker(lease, context, (scope, identity) =>
    scope.execute({ type: "mcpOAuth.consumePending", input: { storeKey, state, identity } }),
  );
}

export function writeMcpOAuthPendingAuthorization(
  storeKey: string,
  state: string,
  lease: OpenClawStateAsyncLeaseContext,
  context: OpenClawStateWorkerContext,
): Promise<void> {
  return runWithOpenClawStateLeaseWorker(lease, context, (scope, identity) =>
    scope.execute({ type: "mcpOAuth.writePending", input: { storeKey, state, identity } }),
  );
}

export function deleteMcpOAuthPendingAuthorization(
  storeKey: string,
  lease: OpenClawStateAsyncLeaseContext,
  context: OpenClawStateWorkerContext,
): Promise<void> {
  return runWithOpenClawStateLeaseWorker(lease, context, (scope, identity) =>
    scope.execute({ type: "mcpOAuth.deletePending", input: { storeKey, identity } }),
  );
}

export function clearMcpOAuthStore(
  storeKey: string,
  lease: OpenClawStateAsyncLeaseContext,
  context: OpenClawStateWorkerContext,
): Promise<void> {
  return runWithOpenClawStateLeaseWorker(lease, context, (scope, identity) =>
    scope.execute({ type: "mcpOAuth.clear", input: { storeKey, identity } }),
  );
}

export function deleteMcpOAuthPendingAuthorizationsByPrefix(
  prefix: string,
  context: OpenClawStateWorkerContext,
): Promise<void> {
  return executeOpenClawStateWorker(context, {
    type: "mcpOAuth.clearPendingPrefix",
    input: prefix,
  });
}
