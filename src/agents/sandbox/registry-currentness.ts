import { registerOpenClawStateDatabaseAsyncResource } from "../../state/openclaw-state-db-cache.js";
import { captureOpenClawStateReadWorkerContext } from "../../state/openclaw-state-worker-context.js";
import type { OpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.types.js";
import { sandboxRegistryPublication } from "./registry-publication.js";
import {
  assertSandboxRegistryGenerationCurrent,
  rowToBrowserEntry,
  rowToContainerEntry,
} from "./registry.kernel.js";
import type { SandboxBrowserRegistryEntry, SandboxRegistryEntry } from "./registry.types.js";

type Entry = SandboxRegistryEntry | SandboxBrowserRegistryEntry;
type Kind = "container" | "browser";
type Facts = { revision: number; entries: Map<string, Entry | null> };
const databases = new Map<string, Facts>();
const keyFor = (kind: Kind, name: string) => JSON.stringify([kind, name]);

function factsFor(identity: string): Facts {
  let facts = databases.get(identity);
  if (!facts) {
    facts = { revision: 0, entries: new Map() };
    databases.set(identity, facts);
  }
  return facts;
}

sandboxRegistryPublication.subscribeFacts((change) => {
  if ("kind" in change) {
    if (change.kind === "unknown" || (change.kind === "settled" && change.outcome === "unknown")) {
      const facts = databases.get(String(change.identity));
      if (facts) {
        facts.revision++;
        facts.entries.clear();
      }
    }
    return;
  }
  // No-op settlement carries no row change to supersede an in-flight read.
  if (change.facts.size === 0) {
    return;
  }
  const facts = factsFor(String(change.source.identity));
  facts.revision++;
  for (const [key, fact] of change.facts) {
    facts.entries.set(
      key,
      fact.kind === "postimage"
        ? fact.value.registry_kind === "container"
          ? rowToContainerEntry(fact.value)
          : rowToBrowserEntry(fact.value)
        : null,
    );
  }
});

registerOpenClawStateDatabaseAsyncResource({
  async close(identity) {
    if (identity) {
      databases.delete(identity.key);
    } else {
      databases.clear();
    }
  },
});

/** Retain read facts for synchronous checks at provider and workspace effects. */
export function captureSandboxRegistryFacts(context: OpenClawStateWorkerContext) {
  const facts = factsFor(context.admission.identity.key);
  const revision = facts.revision;
  return <T extends Entry>(kind: Kind, entries: T[]): T[] => {
    const current = factsFor(context.admission.identity.key);
    for (const entry of entries) {
      const key = keyFor(kind, entry.containerName);
      // A committed receipt wins over a read that was already in flight.
      if (current === facts && facts.revision === revision) {
        current.entries.set(key, structuredClone(entry));
      }
    }
    return entries;
  };
}

export function assertSandboxRegistryFactsCurrent(entry: Entry, kind: Kind): void {
  const { admission } = captureOpenClawStateReadWorkerContext();
  admission.assertCurrent();
  const current = databases
    .get(admission.identity.key)
    ?.entries.get(keyFor(kind, entry.containerName));
  if (kind === "container") {
    assertSandboxRegistryGenerationCurrent(current ?? null, entry);
    return;
  }
  if (
    !current ||
    current.sessionKey !== entry.sessionKey ||
    current.createdAtMs !== entry.createdAtMs ||
    current.workspaceDir !== entry.workspaceDir ||
    current.configHash !== entry.configHash
  ) {
    throw new Error("Sandbox browser workspace owner changed");
  }
}
