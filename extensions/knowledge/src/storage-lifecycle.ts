import path from "node:path";
import { Check } from "typebox/value";
import type { VaultAccess } from "./access.js";
import { inspectEvidence } from "./evidence-files.js";
import { lifecycleRecord, assertLifecycleTarget } from "./lifecycle.js";
import { planMerge, planUnmerge, type MergeReport } from "./merge-write.js";
import { mergeRedirects, referenceIds } from "./merge.js";
import type { LoadedRecord } from "./model.js";
import {
  CorrectInput,
  WithdrawInput,
  type WriteInput,
  type Receipt,
  MergeInput,
  UnmergeInput,
} from "./mutation-contract.js";
import { PublicationFiles } from "./publication-files.js";
import { withdrawnIds, eligible } from "./retrieval.js";
import { encodeRecordEvidence, readSourceDescriptor } from "./source-records.js";
import { StorageEdits } from "./storage-edits.js";
import { canonical, scopeKey, type Prepared } from "./storage-types.js";
import { digest } from "./vault.js";
/** Record lifecycle changes: correction, withdrawal, merge and unmerge. */
export class StorageLifecycle extends StorageEdits {
  async correct(input: CorrectInput, access: VaultAccess, actor: string): Promise<Receipt> {
    if (!Check(CorrectInput, input) || !input.reason.trim()) {
      throw new Error("Invalid correction input.");
    }
    const { kind, ...replacement } = input.replacement;
    return this.publish(
      {
        ...replacement,
        requestId: input.requestId,
        expectedVaultId: input.expectedVaultId,
        expectedOntologyFingerprint: input.expectedOntologyFingerprint,
        // SAFETY: CorrectInput validated the replacement as a write of its declared kind.
      } as WriteInput,
      kind,
      access,
      actor,
      input,
    );
  }
  async withdraw(input: WithdrawInput, access: VaultAccess, actor: string): Promise<Receipt> {
    if (!Check(WithdrawInput, input) || !input.reason.trim()) {
      throw new Error("Invalid withdrawal input.");
    }
    access.assertCurrent();
    if (!this.config.writesEnabled) {
      throw new Error("Knowledge writes are disabled.");
    }
    if (input.expectedVaultId && input.expectedVaultId !== this.config.vaultId) {
      throw new Error("Connected vault changed; no publication accepted.");
    }
    const scope = scopeKey(access.scope),
      intent = digest(canonical({ operation: "withdraw", input }));
    const prior = this.store.withDatabase((db) => this.row(db, scope, input.requestId));
    if (prior) {
      this.checkReplay(prior, intent);
      return this.resume(access, input.requestId);
    }
    this.assertReadable();
    const prepared = await this.real.run(access, async (vault) => {
      const snapshot = new PublicationFiles(this.config.root).snapshot(scope),
        data = await vault.scan();
      const previous = assertLifecycleTarget(data.records, input, false);
      const record = lifecycleRecord(previous, "withdrawn", input, actor);
      if (new PublicationFiles(this.config.root).snapshot(scope) !== snapshot) {
        throw new Error("Edit conflict: vault changed during validation.");
      }
      return { record, previous, artifacts: {}, data, snapshot, lifecycle: input };
    });
    return this.accept(input.requestId, intent, prepared, access, actor);
  }
  /** Merge one duplicate page into another in a single publication; references resolve on read. */
  async merge(input: MergeInput, access: VaultAccess, actor: string): Promise<Receipt> {
    if (!Check(MergeInput, input) || !input.reason.trim()) {
      throw new Error("Invalid merge input.");
    }
    if (input.survivor.id === input.absorbed.id) {
      throw new Error("A page cannot be merged into itself.");
    }
    return this.publishPair(input, "merge", access, (data, withdrawn, at) => {
      const survivor = this.activePage(data, input.survivor, "Survivor"),
        absorbed = this.activePage(data, input.absorbed, "Absorbed");
      if (survivor.type !== absorbed.type) {
        throw new Error(
          `Only pages of the same type can be merged: ${survivor.title} is ${survivor.type}, ${absorbed.title} is ${absorbed.type}. No publication accepted.`,
        );
      }
      for (const evidence of input.evidence ?? []) {
        inspectEvidence(path.join(this.config.root, scopeKey(access.scope)), evidence);
      }
      const plan = planMerge(survivor, absorbed, input, {
        reason: input.reason,
        requestId: input.requestId,
        actor,
        at,
      });
      return {
        survivor,
        absorbed,
        plan,
        targetId: absorbed.id,
        evidence: input.evidence ?? [],
        report: {
          survivorId: survivor.id,
          absorbedId: absorbed.id,
          aliases: plan.aliases,
          fieldConflicts: plan.fieldConflicts,
          redirectedRecords: this.namingCount(data, withdrawn, absorbed.id),
        },
      };
    });
  }
  /** Undo one merge: the merged page is active again and the survivor loses what the merge added. */
  async unmerge(input: UnmergeInput, access: VaultAccess, actor: string): Promise<Receipt> {
    if (!Check(UnmergeInput, input) || !input.reason.trim()) {
      throw new Error("Invalid unmerge input.");
    }
    return this.publishPair(input, "unmerge", access, (data, withdrawn, at) => {
      const survivor = this.activePage(data, input.survivor, "Survivor");
      const matches = data.records.filter((r) => r.id === input.merged.id),
        merged = matches.length === 1 ? matches[0] : undefined;
      if (
        !merged ||
        !merged.valid ||
        merged.lifecycle !== "merged" ||
        merged.hash !== input.merged.expectedHash ||
        merged.revision !== input.merged.expectedRevision
      ) {
        throw new Error(
          `Merged page unavailable, not merged, or changed: ${input.merged.id}. Reread it with knowledge_record and retry with a new request. No publication accepted.`,
        );
      }
      if (merged.metadata.merged_into !== survivor.id) {
        throw new Error(
          `${merged.title} was merged into ${merged.metadata.merged_into}, not ${survivor.id}. Unmerge it from that page. No publication accepted.`,
        );
      }
      const plan = planUnmerge(survivor, merged, {
        reason: input.reason,
        requestId: input.requestId,
        actor,
        at,
      });
      return {
        survivor,
        absorbed: merged,
        plan,
        targetId: merged.id,
        evidence: [],
        report: {
          survivorId: survivor.id,
          absorbedId: merged.id,
          aliases: plan.aliases,
          fieldConflicts: [],
          redirectedRecords: this.namingCount(data, withdrawn, merged.id, true),
        },
      };
    });
  }
  // Current records whose authored references name `id` (directly, or through pages merged into it).
  private namingCount(
    data: Prepared["data"],
    withdrawn: Set<string>,
    id: string,
    authored = false,
  ) {
    const redirects = mergeRedirects(data.records),
      names = (ref: string) => ref === id || redirects.get(ref) === id;
    const records = authored
      ? data.records.filter((r) => r.valid && r.lifecycle === "active")
      : eligible(data, withdrawn, false);
    return records.filter(
      (r) =>
        r.id !== id &&
        [
          ...referenceIds(r.metadata),
          ...(r.metadata.source_page ? [r.metadata.source_page] : []),
        ].some(names),
    ).length;
  }
  // One exact, active, valid page matching its revision fence.
  private activePage(
    data: Prepared["data"],
    fence: { id: string; expectedRevision: number; expectedHash: string },
    role: string,
  ): LoadedRecord {
    const matches = data.records.filter((r) => r.id === fence.id),
      page = matches.length === 1 ? matches[0] : undefined;
    if (page?.lifecycle === "merged") {
      throw new Error(
        `${role} page ${page.title} was already merged into ${page.metadata.merged_into}. Use that page instead. No publication accepted.`,
      );
    }
    if (
      !page ||
      !page.valid ||
      page.kind !== "page" ||
      page.lifecycle !== "active" ||
      page.hash !== fence.expectedHash ||
      page.revision !== fence.expectedRevision
    ) {
      throw new Error(
        `${role} page unavailable, inactive, invalid or changed: ${fence.id}. Reread it with knowledge_record and retry with a new request. No publication accepted.`,
      );
    }
    return page;
  }
  // Shared journal path for merge and unmerge: plan both page revisions, validate them together, publish once.
  private async publishPair(
    input: MergeInput | UnmergeInput,
    operation: "merge" | "unmerge",
    access: VaultAccess,
    plan: (
      data: Prepared["data"],
      withdrawn: Set<string>,
      at: string,
    ) => {
      survivor: LoadedRecord;
      absorbed: LoadedRecord;
      plan: { survivor: LoadedRecord; absorbed: LoadedRecord };
      targetId: string;
      evidence: import("./model.js").Evidence[];
      report: MergeReport;
    },
  ): Promise<Receipt> {
    access.assertCurrent();
    if (!this.config.writesEnabled) {
      throw new Error("Knowledge writes are disabled.");
    }
    if (input.expectedVaultId && input.expectedVaultId !== this.config.vaultId) {
      throw new Error("Connected vault changed; no publication accepted.");
    }
    await this.initialize(access);
    const scope = scopeKey(access.scope),
      intent = digest(canonical({ operation, input }));
    const prior = this.store.withDatabase((db) => this.row(db, scope, input.requestId));
    if (prior) {
      this.checkReplay(prior, intent);
      return this.resume(access, input.requestId);
    }
    this.assertReadable();
    const prepared = await this.real.run(access, async (vault) => {
      const snapshot = new PublicationFiles(this.config.root).snapshot(scope),
        data = await vault.scan();
      const withdrawn = this.store.withDatabase((db) =>
        withdrawnIds(db, this.retrievalBinding(access)),
      );
      const planned = plan(data, withdrawn, new Date().toISOString());
      // Both revisions are stored with compact evidence, exactly like any other page save.
      const read = (p: string) => readSourceDescriptor(path.join(this.config.root, scope), p);
      const survivor = encodeRecordEvidence(planned.plan.survivor, read),
        absorbed = encodeRecordEvidence(planned.plan.absorbed, read);
      const artifacts = { ...survivor.descriptors, ...absorbed.descriptors };
      const preview = await vault.scan({ records: [survivor.record, absorbed.record], artifacts });
      for (const record of [survivor.record, absorbed.record]) {
        if (!record.valid) {
          throw new Error(
            `${operation === "merge" ? "Merge" : "Unmerge"} validation failed for ${record.title}: ` +
              preview.issues
                .filter((i) => i.path === record.path)
                .map((i) => i.message)
                .join("; "),
          );
        }
      }
      if (new PublicationFiles(this.config.root).snapshot(scope) !== snapshot) {
        throw new Error("Edit conflict: vault changed during validation.");
      }
      return {
        previous: planned.survivor,
        record: survivor.record,
        additional: [{ before: planned.absorbed, after: absorbed.record }],
        data,
        snapshot,
        artifacts,
        requiredDescriptors: { ...survivor.requiredDescriptors, ...absorbed.requiredDescriptors },
        metadataOnly: true,
        annotationEvidence: planned.evidence,
        merge: {
          operation,
          targetId: planned.targetId,
          reason: input.reason,
          report: planned.report,
        },
      } satisfies Prepared;
    });
    return this.accept(input.requestId, intent, prepared, access, "agent");
  }
}
