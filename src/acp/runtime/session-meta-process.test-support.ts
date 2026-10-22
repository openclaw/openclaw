import type { SessionAcpMeta } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { closeOpenClawAgentDatabasesAsync } from "../../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseAsync,
  runOpenClawStateWriteTransaction,
} from "../../state/openclaw-state-db.js";
import { upsertAcpSessionMeta } from "./session-meta-write.js";
import { writeAcpSessionMetaForMigration } from "./session-meta.js";

/** Independent canonical writers use the invocation's compiled storage runtime. */
export async function writeAcpMetadataFromProcess(params: {
  mutation:
    | {
        kind: "upsert";
        scope: { cfg: OpenClawConfig; agentId: string; sessionKey: string };
        clear: boolean;
      }
    | {
        kind: "migration";
        rows: Array<{ sessionKey: string; lifecycleRevision: string; meta: SessionAcpMeta }>;
      };
}): Promise<void> {
  const phase = (name: string) => {
    process.stderr.write(`acp-proof:${name}:${performance.now().toFixed(0)}\n`);
  };
  phase("imports-ready");
  try {
    phase("write-start");
    const mutation = params.mutation;
    if (mutation.kind === "upsert") {
      await upsertAcpSessionMeta({
        ...mutation.scope,
        skipMaintenance: true,
        mutate: (current) => {
          if (!current) {
            throw new Error("Expected current metadata before independent write.");
          }
          return mutation.clear ? null : { ...current, lastActivityAt: 200 };
        },
      });
    } else {
      runOpenClawStateWriteTransaction((database) => {
        for (const row of mutation.rows) {
          writeAcpSessionMetaForMigration({ ...row, database });
        }
      });
    }
    phase("write-settled");
  } finally {
    try {
      phase("agent-close-start");
      await closeOpenClawAgentDatabasesAsync();
      phase("agent-close-end");
    } finally {
      phase("state-close-start");
      await closeOpenClawStateDatabaseAsync();
      phase("state-close-end");
    }
  }
}
