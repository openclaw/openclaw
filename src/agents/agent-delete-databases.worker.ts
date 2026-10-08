import type { SqliteReadOnlyOperationContext } from "../infra/sqlite-readonly-operation-types.js";
import {
  inspectDatabasePathIdentitySync,
  type DatabasePathIdentity,
} from "../infra/sqlite-worker-identity.js";
import { inspectOpenClawAgentDatabaseOwner } from "../state/openclaw-agent-db-lifecycle.js";

export const agentDeleteDatabaseReadOperations = {
  "agentRetirement.inspectOwner": (
    input: { identity: DatabasePathIdentity },
    context: SqliteReadOnlyOperationContext,
  ) => {
    const assertIdentity = () => {
      const observed = inspectDatabasePathIdentitySync(context.path);
      if (
        observed?.key !== input.identity.key ||
        observed.birthtime !== input.identity.birthtime ||
        observed.canonicalPath !== input.identity.canonicalPath
      ) {
        throw new Error("Agent session database changed during deletion planning.");
      }
    };
    assertIdentity();
    const owner = inspectOpenClawAgentDatabaseOwner(context.path);
    assertIdentity();
    return owner;
  },
};
