import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { readAgentDatabaseAdmissionRefusal } from "../state/agent-database-admission.js";
import { agentDeletionJournalPublication } from "../state/agent-deletion-journal-publication.js";
import type { AgentLifecycleStoreFacts } from "../state/agent-lifecycle-read.worker.js";
import { agentProvenancePublication } from "../state/agent-provenance-publication.js";
import type { AgentProvenance } from "../state/agent-provenance.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db-contract.js";
import { executeExistingOpenClawStateRead } from "../state/openclaw-state-db-readonly.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { captureOpenClawStateReadWorkerContext } from "../state/openclaw-state-worker-context.js";
import type { OpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.types.js";
import { resolveAgentConfig } from "./agent-scope-config.js";

export type AgentLifecycleBinding = Readonly<{
  agentId: string;
  provenance: AgentProvenance | null;
}>;

type LifecycleFacts = Partial<AgentLifecycleStoreFacts>;
type LifecycleStore = {
  context: OpenClawStateWorkerContext;
  agents: Map<string, LifecycleFacts>;
};

// This projection has complete writer coverage through provenance and journal receipts.
const lifecycleStores = resolveGlobalSingleton(
  Symbol.for("openclaw.agentLifecycleStores"),
  () => {
    const stores = new Map<string, LifecycleStore>();
    agentProvenancePublication.subscribeFacts((change) => {
      for (const store of stores.values()) {
        if (change.kind === "committed") {
          if (change.receipt.source.identity !== store.context.admission.identity.key) {
            continue;
          }
          for (const [agentId, fact] of change.receipt.facts) {
            if (fact.kind !== "unchanged") {
              store.agents.set(agentId, {
                ...store.agents.get(agentId),
                provenance:
                  fact.kind === "postimage"
                    ? fact.value
                    : fact.kind === "absent"
                      ? null
                      : undefined,
              });
            }
          }
        } else if (
          change.kind === "unknown" &&
          change.identity === store.context.admission.identity.key
        ) {
          for (const [agentId, facts] of store.agents) {
            store.agents.set(agentId, { ...facts, provenance: undefined });
          }
        }
      }
    });
    agentDeletionJournalPublication.subscribeFacts((change) => {
      for (const store of stores.values()) {
        if (change.kind === "committed") {
          if (change.receipt.source.identity !== store.context.admission.identity.key) {
            continue;
          }
          for (const [agentId, fact] of change.receipt.facts) {
            if (fact.kind !== "unchanged") {
              store.agents.set(agentId, {
                ...store.agents.get(agentId),
                deletionBlocked:
                  fact.kind === "postimage" ? true : fact.kind === "absent" ? false : undefined,
              });
            }
          }
        } else if (
          change.kind === "unknown" &&
          change.identity === store.context.admission.identity.key
        ) {
          for (const [agentId, facts] of store.agents) {
            store.agents.set(agentId, { ...facts, deletionBlocked: undefined });
          }
        }
      }
    });
    return stores;
  },
  (stores) => stores.clear(),
);

function knownLifecycleFacts(facts: LifecycleFacts | undefined): facts is AgentLifecycleStoreFacts {
  return facts?.deletionBlocked !== undefined && facts.provenance !== undefined;
}

async function readLifecycleFactsInWorker(
  agentId: string,
  options: OpenClawStateDatabaseOptions,
): Promise<AgentLifecycleStoreFacts> {
  const context = captureOpenClawStateReadWorkerContext({
    path: options.database?.path ?? options.path,
    env: options.env,
  });
  let store = lifecycleStores.get(context.admission.databasePath);
  if (!store || store.context.admission.identity.key !== context.admission.identity.key) {
    store = { context, agents: new Map() };
    lifecycleStores.set(context.admission.databasePath, store);
  } else {
    store.context = context;
  }
  const prepared = store.agents.get(agentId);
  if (knownLifecycleFacts(prepared)) {
    return prepared;
  }
  const pending = prepared ?? {};
  store.agents.set(agentId, pending);
  const reply = await executeExistingOpenClawStateRead(
    { path: context.admission.databasePath, env: context.environment },
    { type: "agentLifecycle.read", input: agentId },
    { context, current: true },
  );
  context.admission.assertCurrent();
  if (reply && !reply.ok) {
    throw new Error(reply.message);
  }
  if (reply && reply.type !== "agentLifecycle.read") {
    throw new Error("Unexpected agent lifecycle result");
  }
  const observed = store.agents.get(agentId);
  // A committed receipt supersedes an in-flight read, including an unknown outcome.
  if (observed === pending) {
    const facts = reply?.facts ?? { deletionBlocked: false, provenance: null };
    store.agents.set(agentId, facts);
    return facts;
  }
  return knownLifecycleFacts(observed) ? observed : { deletionBlocked: true, provenance: null };
}

function admitsLifecycleBinding(
  config: OpenClawConfig,
  agentId: string,
  options: OpenClawStateDatabaseOptions,
): boolean {
  return (
    Boolean(resolveAgentConfig(config, agentId)) &&
    !readAgentDatabaseAdmissionRefusal(agentId, options)
  );
}

/** Prepare an incarnation comparison; final consumers still recheck current authority. */
export async function captureAgentLifecycleBinding(
  getConfig: () => OpenClawConfig,
  agentId: string,
  options: OpenClawStateDatabaseOptions = {},
): Promise<AgentLifecycleBinding | undefined> {
  const capturedOptions = {
    path: options.database?.path ?? options.path,
    env: { ...(options.env ?? process.env) },
  };
  const id = normalizeAgentId(agentId);
  if (!admitsLifecycleBinding(getConfig(), id, capturedOptions)) {
    return undefined;
  }
  const facts = await readLifecycleFactsInWorker(id, capturedOptions);
  if (facts.deletionBlocked || !admitsLifecycleBinding(getConfig(), id, capturedOptions)) {
    return undefined;
  }
  return Object.freeze({ agentId: id, provenance: structuredClone(facts.provenance) });
}

/** Preparatory checks may yield; the final effect guard below remains synchronous. */
export async function matchesAgentLifecycleBindingAsync(
  getConfig: () => OpenClawConfig,
  binding: AgentLifecycleBinding,
  options: OpenClawStateDatabaseOptions = {},
): Promise<boolean> {
  const capturedBinding = structuredClone(binding);
  const capturedOptions = {
    path: options.database?.path ?? options.path,
    env: { ...(options.env ?? process.env) },
  };
  const id = normalizeAgentId(capturedBinding.agentId);
  if (id !== capturedBinding.agentId || !admitsLifecycleBinding(getConfig(), id, capturedOptions)) {
    return false;
  }
  const facts = await readLifecycleFactsInWorker(id, capturedOptions);
  return (
    !facts.deletionBlocked &&
    admitsLifecycleBinding(getConfig(), id, capturedOptions) &&
    isDeepStrictEqual(facts.provenance, capturedBinding.provenance)
  );
}

/** The final effect check consumes prepared owner facts and never queries SQLite. */
export function matchesAgentLifecycleBinding(
  config: OpenClawConfig,
  binding: AgentLifecycleBinding,
  options: OpenClawStateDatabaseOptions = {},
): boolean {
  const id = normalizeAgentId(binding.agentId);
  if (id !== binding.agentId || !admitsLifecycleBinding(config, id, options)) {
    return false;
  }
  const pathname = path.resolve(
    options.database?.path ??
      options.path ??
      resolveOpenClawStateSqlitePath(options.env ?? process.env),
  );
  const store = lifecycleStores.get(pathname);
  try {
    store?.context.admission.assertCurrent();
  } catch {
    return false;
  }
  const facts = store?.agents.get(id);
  return (
    knownLifecycleFacts(facts) &&
    !facts.deletionBlocked &&
    isDeepStrictEqual(facts.provenance, binding.provenance)
  );
}
