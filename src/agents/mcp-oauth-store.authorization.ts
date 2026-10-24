import type { OpenClawStateDatabaseReadAdmission } from "../state/openclaw-state-db-async-lifecycle.js";
import { registerOpenClawStateDatabaseLifecycleListener } from "../state/openclaw-state-db-cache.js";
import { McpConnectionAuthorityError } from "./mcp-connection-authority-error.js";
import type { McpOAuthAuthorizationFact } from "./mcp-oauth-authorization-facts.js";

type AuthorizationState = {
  revision: object;
  fact: McpOAuthAuthorizationFact;
  pending: number;
  uncertain: boolean;
  references: number;
};

// This is the credential writer's live publication, not a second credential store.
// It contains no tokens and never supplies canonical reads or refresh decisions.
const databases = new Map<string, Map<string, AuthorizationState>>();
let observingLifecycle = false;

export function retainMcpOAuthAuthorizationState(
  admission: OpenClawStateDatabaseReadAdmission,
  storeKey: string,
) {
  if (!observingLifecycle) {
    observingLifecycle = true;
    registerOpenClawStateDatabaseLifecycleListener((event) => {
      if (event.kind !== "opened" && event.identity) {
        databases.delete(event.identity.key);
      }
    });
  }
  admission.assertCurrent();
  const databaseKey = admission.identity.key;
  let stores = databases.get(databaseKey);
  if (!stores) {
    stores = new Map();
    databases.set(databaseKey, stores);
  }
  let state = stores.get(storeKey);
  if (!state) {
    state = {
      revision: {},
      fact: { authorizationId: null },
      pending: 0,
      uncertain: false,
      references: 0,
    };
    stores.set(storeKey, state);
  }
  const owner = state;
  owner.references++;
  let released = false;
  const assertCurrent = () => {
    try {
      admission.assertCurrent();
    } catch {
      throw new McpConnectionAuthorityError("retired");
    }
    if (released || databases.get(databaseKey)?.get(storeKey) !== owner) {
      throw new McpConnectionAuthorityError("retired");
    }
  };
  const assertSettled = () => {
    assertCurrent();
    if (owner.uncertain || owner.pending) {
      throw new McpConnectionAuthorityError("unavailable");
    }
  };
  return {
    assertSettled,
    assertAuthorization(authorizationId: string) {
      assertSettled();
      if (
        owner.fact.authorizationId !== authorizationId ||
        (owner.fact.expiresAt !== undefined && owner.fact.expiresAt <= Date.now())
      ) {
        throw new McpConnectionAuthorityError("retired");
      }
    },
    prepareRead() {
      assertSettled();
      const revision = owner.revision;
      return (fact: McpOAuthAuthorizationFact) => {
        assertSettled();
        if (owner.revision !== revision) {
          throw new McpConnectionAuthorityError("unavailable");
        }
        if (
          owner.fact.authorizationId !== fact.authorizationId ||
          owner.fact.expiresAt !== fact.expiresAt
        ) {
          owner.revision = {};
          owner.fact = fact;
        }
      };
    },
    /** Called synchronously before the native lease owner can grant COMMIT. */
    fence() {
      assertCurrent();
      owner.revision = {};
      owner.pending++;
      let settled = false;
      return (known: boolean, fact?: McpOAuthAuthorizationFact) => {
        if (settled) {
          return;
        }
        settled = true;
        // Settlement must survive caller revocation and database close. It can never
        // publish into a replacement owner, and an unknown outcome never reopens this one.
        if (!known) {
          owner.uncertain = true;
        } else if (fact) {
          owner.fact = fact;
        }
        owner.revision = {};
        owner.pending--;
      };
    },
    release(this: void) {
      if (released) {
        return;
      }
      released = true;
      owner.references--;
      if (
        !owner.references &&
        !owner.pending &&
        !owner.uncertain &&
        databases.get(databaseKey)?.get(storeKey) === owner
      ) {
        stores.delete(storeKey);
        if (!stores.size) {
          databases.delete(databaseKey);
        }
      }
    },
  };
}
