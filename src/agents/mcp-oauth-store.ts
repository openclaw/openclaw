// Canonical MCP OAuth session state. Legacy JSON import belongs to doctor only.
import {
  createSqliteWorkerWriteAdmission,
  type SqliteWorkerStore,
} from "../infra/sqlite-worker-store.js";
import { executeExistingOpenClawStateRead } from "../state/openclaw-state-db-readonly.js";
import type { OpenClawStateAsyncLeaseContext } from "../state/openclaw-state-lease-context.js";
import { runWithOpenClawStateLeaseWorker } from "../state/openclaw-state-lease-worker-operation.js";
import {
  withOpenClawStateLeaseWorkerAdmission,
  type OpenClawStateLeaseWorkerAuthority,
} from "../state/openclaw-state-lease-worker-owner.js";
import type { OpenClawStateLeaseIdentity } from "../state/openclaw-state-lease.types.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import type { OpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.types.js";
import type { OpenClawStateWorkerOperations } from "../state/openclaw-state-worker-contract.js";
import {
  executeOpenClawStateWorker,
  runOpenClawStateWorkerOperation,
} from "../state/openclaw-state-worker-store.js";
import { isMcpOAuthAuthorizationReceipt } from "./mcp-oauth-authorization-facts.js";
import {
  projectMcpOAuthCredentialsStatus,
  type McpOAuthPrincipalStatus,
} from "./mcp-oauth-status.js";
import { retainMcpOAuthAuthorizationState } from "./mcp-oauth-store.authorization.js";
import type { McpOAuthStore, McpOAuthMutation } from "./mcp-oauth-store.types.js";
export type { McpOAuthStore } from "./mcp-oauth-store.types.js";

export type McpOAuthStoreWriteOptions = {
  storeKey: string;
  lease: OpenClawStateAsyncLeaseContext;
  context: OpenClawStateWorkerContext;
};

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

/** Apply a bounded mutation under its original live store lease. */
export function mutateMcpOAuthStore(
  { storeKey, lease, context }: McpOAuthStoreWriteOptions,
  mutation: McpOAuthMutation,
  authority?: OpenClawStateLeaseWorkerAuthority,
): Promise<{ store: McpOAuthStore; applied: boolean }> {
  // Capture caller-owned values before worker opening can yield.
  const captured = structuredClone(mutation);
  return runMcpOAuthCredentialWrite(
    { storeKey, lease, context },
    (scope, identity) =>
      scope.execute(
        { type: "mcpOAuth.mutate", input: { storeKey, identity, mutation: captured } },
        { signal: lease.signal },
      ),
    authority,
  );
}

/** Claim one exact unexpired callback state while its store lease is still owned. */
export function consumeOAuthState(
  { storeKey, lease, context }: McpOAuthStoreWriteOptions,
  state: string,
  authority?: OpenClawStateLeaseWorkerAuthority,
): Promise<boolean> {
  return runWithOpenClawStateLeaseWorker(
    lease,
    context,
    (scope, identity) =>
      scope.execute(
        { type: "mcpOAuth.consumePending", input: { storeKey, identity, state } },
        { signal: lease.signal },
      ),
    authority,
  );
}

/** Replace one store's callback state after OAuth persisted its session. */
export function writeMcpOAuthPendingAuthorization(
  { storeKey, lease, context }: McpOAuthStoreWriteOptions,
  state: string,
  authority?: OpenClawStateLeaseWorkerAuthority,
): Promise<void> {
  return runWithOpenClawStateLeaseWorker(
    lease,
    context,
    (scope, identity) =>
      scope.execute(
        { type: "mcpOAuth.writePending", input: { storeKey, identity, state } },
        { signal: lease.signal },
      ),
    authority,
  );
}

/** Delete callback correlation for one settled or cleared OAuth store. */
export function deleteMcpOAuthPendingAuthorization(
  { storeKey, lease, context }: McpOAuthStoreWriteOptions,
  authority?: OpenClawStateLeaseWorkerAuthority,
): Promise<void> {
  return runWithOpenClawStateLeaseWorker(
    lease,
    context,
    (scope, identity) =>
      scope.execute(
        { type: "mcpOAuth.deletePending", input: { storeKey, identity } },
        { signal: lease.signal },
      ),
    authority,
  );
}

/** Clear one OAuth session while retaining explicit logout provenance. */
export function clearMcpOAuthStore({
  storeKey,
  lease,
  context,
}: McpOAuthStoreWriteOptions): Promise<void> {
  return runMcpOAuthCredentialWrite({ storeKey, lease, context }, (scope, identity) =>
    scope.execute(
      { type: "mcpOAuth.clear", input: { storeKey, identity } },
      { signal: lease.signal },
    ),
  );
}

/** The lease owns admission; the credential owner fences and publishes its authorization fact. */
async function runMcpOAuthCredentialWrite<T>(
  { storeKey, lease, context }: McpOAuthStoreWriteOptions,
  operation: (
    scope: Pick<SqliteWorkerStore<OpenClawStateWorkerOperations>, "execute">,
    identity: OpenClawStateLeaseIdentity,
  ) => Promise<T>,
  authority?: OpenClawStateLeaseWorkerAuthority,
): Promise<T> {
  let owner: ReturnType<typeof retainMcpOAuthAuthorizationState> | undefined;
  let settle: ReturnType<ReturnType<typeof retainMcpOAuthAuthorizationState>["fence"]> | undefined;
  let publicationSettled: Promise<void> | undefined;
  const assertCaller = authority?.assertCurrent;
  const beforeCommit = authority?.beforeCommit;
  try {
    return await withOpenClawStateLeaseWorkerAdmission(
      lease,
      context.admission.databasePath,
      (leaseScope) =>
        runOpenClawStateWorkerOperation(context, (scope) => operation(scope, leaseScope.identity), {
          assertCurrent: leaseScope.assertCurrent,
          createAdmission(retained) {
            const binding = leaseScope.createAdmission(retained);
            publicationSettled = retained.settled.then((outcome) => {
              if (!settle) {
                return;
              }
              let known = false;
              try {
                const receipt = binding.admission.committed?.facts;
                if (
                  receipt !== undefined &&
                  (!isMcpOAuthAuthorizationReceipt(receipt) || receipt.storeKey !== storeKey)
                ) {
                  throw new Error("MCP OAuth mutation returned an invalid commit receipt");
                }
                known = outcome.kind !== "unknown";
                settle(known, receipt?.authorization);
              } finally {
                settle(known);
              }
            });
            void publicationSettled.catch(() => undefined);
            return binding;
          },
        }),
      {
        assertCurrent: () => assertCaller?.(),
        beforeCommit() {
          beforeCommit?.();
          owner = retainMcpOAuthAuthorizationState(context.admission, storeKey);
          settle = owner.fence();
        },
      },
    );
  } finally {
    try {
      // Result delivery or caller revocation cannot reopen a still-pending native commit.
      await publicationSettled;
    } finally {
      owner?.release();
    }
  }
}

/** Remove orphan callback rows for a removed server's requester prefix. */
export function deleteMcpOAuthPendingAuthorizationsByPrefix(
  prefix: string,
  context: OpenClawStateWorkerContext = captureOpenClawStateWorkerContext(),
): Promise<void> {
  return runOpenClawStateWorkerOperation(
    context,
    (scope) => scope.execute({ type: "mcpOAuth.clearPendingPrefix", input: prefix }),
    {
      assertCurrent: context.admission.assertCurrent,
      createAdmission: createSqliteWorkerWriteAdmission(context.admission.assertCurrent, [
        context.admission.databasePath,
      ]),
    },
  );
}
