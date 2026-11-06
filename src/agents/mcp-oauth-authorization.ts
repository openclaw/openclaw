import { withOpenClawStateLeaseAsync } from "../state/openclaw-state-lease.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { McpConnectionAuthorityError } from "./mcp-connection-authority-error.js";
import type { McpConnectionAuthority } from "./mcp-connection-authority.types.js";
import {
  hasMcpOAuthAuthorization,
  projectMcpOAuthAuthorization,
} from "./mcp-oauth-authorization-facts.js";
import type { McpOAuthIdentity } from "./mcp-oauth-identity.js";
import { retainMcpOAuthAuthorizationState } from "./mcp-oauth-store.authorization.js";
import { mutateMcpOAuthStore, readMcpOAuthStoreReadOnly } from "./mcp-oauth-store.js";

/** Capture native credential custody without refreshing or holding a flow lease over a source. */
export async function captureMcpOAuthAuthorization(params: {
  identity: McpOAuthIdentity;
  assertCurrent: () => void;
}): Promise<McpConnectionAuthority> {
  const storeKey = params.identity.storeKey;
  const assertCaller = params.assertCurrent;
  const context = captureOpenClawStateWorkerContext();
  const assertSource = () => {
    assertCaller();
    try {
      context.maintenanceScope?.assertAdmission();
      context.admission.assertCurrent();
    } catch {
      throw new McpConnectionAuthorityError("retired");
    }
  };
  assertSource();
  const owner = retainMcpOAuthAuthorizationState(context.admission, storeKey);
  const readCanonical = async () => {
    assertSource();
    const publish = owner.prepareRead();
    const store = await readMcpOAuthStoreReadOnly(storeKey, context).catch(() => {
      assertSource();
      throw new McpConnectionAuthorityError("unavailable");
    });
    assertSource();
    publish(projectMcpOAuthAuthorization(store));
    return store;
  };
  try {
    let store = await readCanonical();
    if (
      !hasMcpOAuthAuthorization(store) ||
      (!store.tokens?.refresh_token &&
        store.tokenExpiresAt !== undefined &&
        store.tokenExpiresAt <= Date.now())
    ) {
      throw new McpConnectionAuthorityError("retired");
    }
    if (!store.authorizationId) {
      // Legacy rows acquire their incarnation through the existing serialized writer.
      // Capture may run inside login verification; take no lease unless initialization
      // is necessary, and release it before any connection/network callback can run.
      await withOpenClawStateLeaseAsync(
        { scope: "core:mcp-oauth", key: storeKey, leaseMs: 60_000, waitMs: 30_000 },
        context,
        (lease) =>
          mutateMcpOAuthStore(
            { storeKey, lease, context },
            { kind: "ensureAuthorization" },
            { assertCurrent: assertSource },
          ),
      );
      store = await readCanonical();
    }
    const authorizationId = store.authorizationId;
    if (!authorizationId) {
      throw new McpConnectionAuthorityError("retired");
    }
    let observation: "ready" | "pending" | "unavailable" = "ready";
    const assertCurrent = () => {
      assertSource();
      owner.assertAuthorization(authorizationId);
      if (observation !== "ready") {
        throw new McpConnectionAuthorityError("unavailable");
      }
    };
    assertCurrent();
    return {
      authorizationId,
      assertCurrent,
      async revalidate() {
        assertSource();
        owner.assertAuthorization(authorizationId);
        if (observation === "pending") {
          throw new McpConnectionAuthorityError("unavailable");
        }
        observation = "pending";
        try {
          await readCanonical();
          assertSource();
          owner.assertAuthorization(authorizationId);
          observation = "ready";
        } catch (error) {
          observation = "unavailable";
          throw error;
        }
      },
      dispose: owner.release,
    };
  } catch (error) {
    owner.release();
    throw error;
  }
}
