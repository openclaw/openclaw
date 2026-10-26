import type { Static } from "typebox";
import { Check } from "typebox/value";
import type { VaultAccess } from "./access.js";
import {
  TimelineInput,
  DayInput,
  LastSeenInput,
  LastSeenOutput,
  SinceInput,
} from "./chronicle-contract.js";
import { chronicle } from "./chronicle.js";
import type { ConnectionsInput } from "./connections-contract.js";
import { connections } from "./connections.js";
import { EvidenceReadInput } from "./evidence-read-contract.js";
import { VerifyInput, type VerifyOutput } from "./ingestion-contract.js";
import { buildMemoryIndex } from "./memory-index.js";
import { approvedRecall } from "./model.js";
import { recentActivity } from "./recent-activity.js";
import type { RecentInput } from "./recent.js";
import { withinBudget } from "./response-budget.js";
import type { SearchInput, LookupInput } from "./retrieval-contract.js";
import {
  keywordSearch,
  verifyKeywordIndex,
  exactLookup,
  withdrawnIds,
  eligible,
} from "./retrieval.js";
import {
  appendActivity,
  sessionActivity,
  returnedRecords,
  type ActivityInput,
} from "./session-activity.js";
import { StorageIngestion } from "./storage-ingestion.js";
import { scopeKey } from "./storage-types.js";
import { verifyRecords } from "./verification.js";

export class KnowledgeStorage extends StorageIngestion {
  async trackRead<T>(
    access: VaultAccess,
    operation: string,
    read: () => T | Promise<T>,
  ): Promise<T> {
    const result = await read();
    if (
      access.activity &&
      [
        "search",
        "lookup",
        "records",
        "record",
        "evidenceRead",
        "connections",
        "timeline",
        "chronicleDay",
        "chronicleSince",
        "chronicleLastSeen",
      ].includes(operation)
    ) {
      const records = returnedRecords(result);
      // Best effort: observation must not turn a successful read into a failed read.
      // Authority failures still prevent delivery, even when telemetry fails.
      access.assertCurrent();
      try {
        this.store.withDatabase((db) =>
          appendActivity(
            db,
            scopeKey(access.scope),
            access.agentId,
            access.activity!,
            "read",
            records,
          ),
        );
      } catch {
        /* This is a session explorer, not a complete security audit log. */
      }
    }
    access.assertCurrent();
    return result;
  }
  async sessionActivity(input: ActivityInput, access: VaultAccess) {
    return this.run(access, async (vault) => {
      const data = await vault.scan();
      access.assertCurrent();
      return this.store.withDatabase((db) =>
        sessionActivity(
          db,
          scopeKey(access.scope),
          access.agentId,
          eligible(data, withdrawnIds(db, this.retrievalBinding(access)), false),
          input,
        ),
      );
    });
  }
  /** Keep durable withdrawal tombstones authoritative even after external file restoration. */
  async evidenceRead(input: EvidenceReadInput, access: VaultAccess) {
    if (!Check(EvidenceReadInput, input)) {
      throw new Error("Invalid evidence passage input.");
    }
    return this.run(access, async (vault) => {
      await vault.scan();
      const withdrawn = this.store.withDatabase((db) =>
        withdrawnIds(db, this.retrievalBinding(access)),
      );
      return vault.evidenceRead(input, withdrawn);
    });
  }
  async search(input: SearchInput, access: VaultAccess) {
    return this.run(access, async (vault) => {
      const data = await vault.scan();
      access.assertCurrent();
      return this.store.withDatabase((db) =>
        keywordSearch(
          db,
          data,
          input,
          this.retrievalBinding(access),
          this.config.vaultId,
          withdrawnIds(db, this.retrievalBinding(access)),
        ),
      );
    });
  }
  async verify(input: VerifyInput, access: VaultAccess): Promise<VerifyOutput> {
    if (!Check(VerifyInput, input)) {
      throw new Error("Invalid verification input.");
    }
    return this.run(access, async (vault) => {
      const data = await vault.scan();
      const result = this.store.withDatabase((db) => {
        const binding = this.retrievalBinding(access);
        const indexed = verifyKeywordIndex(
          db,
          data,
          binding,
          this.config.vaultId,
          withdrawnIds(db, binding),
        );
        return verifyRecords(data, input, indexed);
      });
      access.assertCurrent();
      return result;
    });
  }
  async lookup(input: LookupInput, access: VaultAccess) {
    return this.run(access, async (vault) => {
      const data = await vault.scan();
      access.assertCurrent();
      return this.store.withDatabase((db) =>
        exactLookup(data, input, withdrawnIds(db, this.retrievalBinding(access))),
      );
    });
  }
  async connections(input: Static<typeof ConnectionsInput>, access: VaultAccess) {
    return this.run(access, async (vault) => {
      const data = await vault.scan();
      access.assertCurrent();
      return this.store.withDatabase((db) =>
        connections(data, input, withdrawnIds(db, this.retrievalBinding(access))),
      );
    });
  }
  /** Enumerates approved automatic-recall projections without returning record bodies. */
  async memoryCandidates(
    input: { kind: "trigger" | "project"; limit: number },
    access: VaultAccess,
  ) {
    return this.run(access, async (vault) => {
      const data = await vault.scan();
      const records = this.store
        .withDatabase((db) =>
          eligible(data, withdrawnIds(db, this.retrievalBinding(access)), false),
        )
        .filter((record) => record.lifecycle === "active")
        .flatMap((record) => {
          const recall = approvedRecall(record.metadata.recall);
          if (
            !recall ||
            (input.kind === "trigger" ? !recall.triggers?.length : !recall.projects?.length)
          ) {
            return [];
          }
          return [
            {
              id: record.id,
              title: record.title,
              path: record.path,
              revision: record.revision,
              hash: record.hash,
              recall,
            },
          ];
        })
        .toSorted(
          (a, b) =>
            (b.recall.importance ?? 0) - (a.recall.importance ?? 0) ||
            (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
        );
      const result = {
        records: records.slice(0, input.limit),
        complete: data.issues.length === 0 && records.length <= input.limit,
      };
      // Bound the worker boundary as well as the final provider projection.
      while (!withinBudget(result) && result.records.length) {
        result.records.pop();
        result.complete = false;
      }
      access.assertCurrent();
      return result;
    });
  }
  /** Renders the standing index of this partition's current records as of `asOf`. */
  async memoryIndex(input: { asOf: number }, access: VaultAccess) {
    if (!Number.isFinite(input.asOf)) {
      throw new Error("Invalid memory index cutoff.");
    }
    return this.run(access, async (vault) => {
      const data = await vault.scan();
      const records = this.store.withDatabase((db) =>
        eligible(data, withdrawnIds(db, this.retrievalBinding(access)), false),
      );
      access.assertCurrent();
      return { text: buildMemoryIndex(records, input.asOf) };
    });
  }
  /** Read temporal projections within the same authority and identity fence as search. */
  async timeline(
    input: Static<typeof TimelineInput>,
    access: VaultAccess,
    day?: Static<typeof DayInput>,
  ) {
    if (!Check(TimelineInput, input) || (day && !Check(DayInput, day))) {
      throw new Error("Invalid temporal query input.");
    }
    return this.run(access, async (vault) => {
      const data = await vault.scan();
      access.assertCurrent();
      const result = this.store.withDatabase((db) =>
        chronicle(
          db,
          data,
          this.retrievalBinding(access),
          input,
          withdrawnIds(db, this.retrievalBinding(access)),
          day,
        ),
      );
      access.assertCurrent();
      return result;
    });
  }
  /** Day and week queries preserve authored date-only precision. */
  async chronicleDay(input: Static<typeof DayInput>, access: VaultAccess) {
    const { date: _date, timezone: _timezone, week: _week, ...filters } = input;
    return this.timeline({ ...filters, order: "asc" }, access, input);
  }
  /** Occurrence-time range, not a storage-change feed. */
  async chronicleSince(input: SinceInput, access: VaultAccess) {
    if (!Check(SinceInput, input)) {
      throw new Error("Invalid since query input.");
    }
    return this.timeline({ ...input, order: "asc" }, access);
  }
  /** Last dated context at a reference instant; never infer contact from absence. */
  async chronicleLastSeen(
    input: Static<typeof LastSeenInput>,
    access: VaultAccess,
  ): Promise<Static<typeof LastSeenOutput>> {
    if (!Check(LastSeenInput, input)) {
      throw new Error("Invalid last-seen input.");
    }
    const cutoff = input.occurredOnOrBefore ?? new Date().toISOString();
    const result = await this.timeline(
      {
        entity: input.entity,
        until: cutoff,
        eligibility: input.eligibility,
        includeSources: input.includeSources,
        order: "desc",
        limit: 1,
      },
      access,
    );
    return {
      entity: input.entity,
      selection: {
        timeField: "occurred_at",
        onOrBefore: cutoff,
        eligibility: input.eligibility ?? "current",
      },
      last: result.items[0] ?? null,
      snapshot: result.snapshot,
      freshness: result.freshness,
      ...(result.sources ? { sources: result.sources } : {}),
      message:
        "Latest eligible dated context; a mention is not proof of contact. No match does not establish absence of an interaction.",
    };
  }
  async recent(input: Static<typeof RecentInput>, access: VaultAccess) {
    return this.run(access, async (vault) => {
      const data = await vault.scan();
      access.assertCurrent();
      return this.store.withDatabase((db) => {
        const result = recentActivity(
          db,
          scopeKey(access.scope),
          eligible(data, withdrawnIds(db, this.retrievalBinding(access)), false),
          input,
          data.records.filter((r) => r.metadata.record_class === "fixture").map((r) => r.id),
        );
        access.assertCurrent();
        return result;
      });
    });
  }
}
