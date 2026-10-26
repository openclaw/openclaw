import path from "node:path";
import type { Static } from "typebox";
import { Check } from "typebox/value";
import { parseDocument } from "yaml";
import type { VaultAccess } from "./access.js";
import { annotationEvidence, annotationProblems } from "./annotations.js";
import { EditBodyInput } from "./body-edit-contract.js";
import { editBody } from "./body-edit.js";
import { inspectEvidence } from "./evidence-files.js";
import {
  ReconcileEvidenceInput,
  type EvidencePreview,
} from "./evidence-reconciliation-contract.js";
import { prepareEvidenceRevision } from "./evidence-reconciliation.js";
import { parseYaml } from "./files.js";
import { RECORD_MAX_BYTES } from "./limits.js";
import { mergeRedirects } from "./merge.js";
import { approvedRecall, Envelope, type LoadedRecord, type Recall } from "./model.js";
import {
  AnnotateInput,
  SavePage,
  ClaimInput,
  RelationshipInput,
  RecallInput,
  type Receipt,
} from "./mutation-contract.js";
import { PublicationFiles } from "./publication-files.js";
import { withinBudget } from "./response-budget.js";
import { withdrawnIds, eligible } from "./retrieval.js";
import { encodeRecordEvidence, readSourceDescriptor } from "./source-records.js";
import { StoragePublication } from "./storage-publication.js";
import { canonical, scopeKey } from "./storage-types.js";
import { digest } from "./vault.js";
/** Fenced edits of existing records: body edits, evidence reconciliation, annotations and recall approval. */
export class StorageEdits extends StoragePublication {
  /** Publish one bounded page-body change through the normal fenced journal. */
  async editBody(input: EditBodyInput, access: VaultAccess): Promise<Receipt> {
    if (!Check(EditBodyInput, input) || !input.reason.trim() || !withinBudget(input)) {
      throw new Error("Invalid or oversized body edit input.");
    }
    access.assertCurrent();
    if (!this.config.writesEnabled) {
      throw new Error("Knowledge writes are disabled.");
    }
    if (input.expectedVaultId !== this.config.vaultId) {
      throw new Error("Connected vault changed; no publication accepted.");
    }
    await this.initialize(access);
    const scope = scopeKey(access.scope),
      intent = digest(canonical({ operation: "editBody", input }));
    const prior = this.store.withDatabase((db) => this.row(db, scope, input.requestId));
    if (prior) {
      this.checkReplay(prior, intent);
      return this.resume(access, input.requestId);
    }
    this.assertReadable();
    // Assemble inside the authorized store; full body never crosses the tool input.
    const prepared = await this.real.run(access, async (vault) => {
      const data = await vault.scan(),
        matches = data.records.filter((r) => r.id === input.id);
      const previous = matches.length === 1 ? matches[0] : undefined;
      if (
        !previous ||
        !previous.valid ||
        previous.kind !== "page" ||
        previous.lifecycle !== "active" ||
        previous.hash !== input.expectedHash ||
        previous.revision !== input.expectedRevision
      ) {
        throw new Error("Body edit conflict: target unavailable or changed.");
      }
      const body = editBody(previous.body, input);
      // prepare rechecks the revision and ontology, validates references and final bytes.
      return this.prepare(
        vault,
        {
          requestId: input.requestId,
          id: input.id,
          expectedVaultId: input.expectedVaultId,
          expectedRevision: input.expectedRevision,
          expectedHash: input.expectedHash,
          expectedOntologyFingerprint: input.expectedOntologyFingerprint,
          title: previous.title,
          body,
          // SAFETY: a page save reads only these SavePage fields; prepare rechecks revision, ontology and bytes.
        } as SavePage & ClaimInput & RelationshipInput,
        "page",
        access,
        "agent",
        undefined,
        undefined,
        undefined,
        input.reason,
      );
    });
    return this.accept(input.requestId, intent, prepared, access, "agent");
  }
  /** Preview or publish one explicit support/representation revision without source deletion. */
  async reconcileEvidence(
    input: ReconcileEvidenceInput,
    access: VaultAccess,
  ): Promise<EvidencePreview | Receipt> {
    if (!Check(ReconcileEvidenceInput, input) || !input.reason.trim()) {
      throw new Error("Invalid evidence reconciliation input.");
    }
    access.assertCurrent();
    if (!this.config.writesEnabled) {
      throw new Error("Knowledge writes are disabled.");
    }
    if (input.expectedVaultId !== this.config.vaultId) {
      throw new Error("Connected vault changed; no publication accepted.");
    }
    await this.initialize(access);
    const scope = scopeKey(access.scope),
      intent = digest(canonical({ operation: "reconcileEvidence", input }));
    const prior = this.store.withDatabase((db) => this.row(db, scope, input.requestId));
    if (prior) {
      this.checkReplay(prior, intent);
      return this.resume(access, input.requestId);
    }
    this.assertReadable();
    const prepared = await this.real.run(access, async (vault) => {
      const snapshot = new PublicationFiles(this.config.root).snapshot(scope),
        data = await vault.scan();
      if (data.ontology?.fingerprint !== input.expectedOntologyFingerprint) {
        throw new Error("Ontology changed; inspect before reconciling evidence.");
      }
      const matches = data.records.filter((r) => r.id === input.id);
      if (matches.length !== 1) {
        throw new Error("Evidence reconciliation target unavailable or ambiguous.");
      }
      const previous = matches[0]!;
      const encoded = prepareEvidenceRevision(previous, input, (p) =>
        readSourceDescriptor(path.join(this.config.root, scope), p),
      );
      const preview = await vault.scan({ record: encoded.record, artifacts: encoded.descriptors });
      if (!encoded.record.valid) {
        throw new Error(
          "Evidence reconciliation validation failed: " +
            preview.issues
              .filter((i) => i.path === previous.path)
              .map((i) => i.code)
              .join(", "),
        );
      }
      if (new PublicationFiles(this.config.root).snapshot(scope) !== snapshot) {
        throw new Error("Edit conflict: vault changed during validation.");
      }
      return {
        previous,
        record: encoded.record,
        data,
        snapshot,
        artifacts: encoded.descriptors,
        requiredDescriptors: encoded.requiredDescriptors,
        metadataOnly: true,
        annotationEvidence: [
          ...(encoded.record.metadata.evidence ?? []),
          ...annotationEvidence(encoded.record.metadata),
        ],
      };
    });
    // Preview does not write descriptors or a mutation row. Apply always revalidates fences.
    access.assertCurrent();
    if (input.dryRun) {
      return {
        state: "preview",
        id: input.id,
        revision: prepared.previous.revision,
        hash: prepared.previous.hash,
        beforeBytes: Buffer.byteLength(prepared.previous.raw),
        afterBytes: Buffer.byteLength(prepared.record.raw),
        beforeEvidence: prepared.previous.metadata.evidence?.length ?? 0,
        afterEvidence: prepared.record.metadata.evidence?.length ?? 0,
        descriptors: Object.keys(prepared.artifacts).length,
        representation: input.representation,
      };
    }
    return this.accept(
      input.requestId,
      intent,
      prepared,
      access,
      input.evidence === undefined ? "conversion" : "agent",
    );
  }
  async annotate(input: AnnotateInput, access: VaultAccess, actor: string): Promise<Receipt> {
    if (
      !Check(AnnotateInput, input) ||
      !input.reason.trim() ||
      (!Object.keys(input.annotations).length &&
        !input.addEvidence?.length &&
        input.entities === undefined)
    ) {
      throw new Error("Invalid annotation input.");
    }
    access.assertCurrent();
    if (!this.config.writesEnabled) {
      throw new Error("Knowledge writes are disabled.");
    }
    if (input.expectedVaultId && input.expectedVaultId !== this.config.vaultId) {
      throw new Error("Connected vault changed; no publication accepted.");
    }
    await this.initialize(access);
    const scope = scopeKey(access.scope),
      intent = digest(canonical({ operation: "annotate", input }));
    const prior = this.store.withDatabase((db) => this.row(db, scope, input.requestId));
    if (prior) {
      this.checkReplay(prior, intent);
      return this.resume(access, input.requestId);
    }
    this.assertReadable();
    const prepared = await this.real.run(access, async (vault) => {
      const snapshot = new PublicationFiles(this.config.root).snapshot(scope),
        data = await vault.scan();
      const matches = data.records.filter((r) => r.id === input.id),
        previous = matches.length === 1 ? matches[0] : undefined;
      if (
        !previous ||
        previous.hash !== input.expectedHash ||
        previous.revision !== input.expectedRevision
      ) {
        throw new Error("Annotation conflict: target unavailable or changed.");
      }
      if (
        previous.lifecycle !== "active" &&
        (Object.keys(input.annotations).some((k) => k !== "record_class") ||
          input.addEvidence?.length ||
          input.entities !== undefined)
      ) {
        throw new Error("Only fixture classification may annotate historical records.");
      }
      const metadata: Envelope = {
        ...previous.metadata,
        ...input.annotations,
        revision: previous.revision + 1,
        updated_at: new Date().toISOString(),
      };
      // Linking moves a claim by ID onto its subject (gbrain relink); it is not a correction.
      if (input.entities !== undefined) {
        if (previous.kind !== "claim") {
          throw new Error("Entity annotations require a claim.");
        }
        const redirects = mergeRedirects(data.records),
          stale = input.entities.find((id) => redirects.has(id));
        if (stale) {
          throw new Error(
            `Reference ${stale} is a page that was merged into ${redirects.get(stale)}. Reference ${redirects.get(stale)} instead. No publication accepted.`,
          );
        }
        const allowed = this.store.withDatabase((db) =>
          eligible(data, withdrawnIds(db, this.retrievalBinding(access)), false),
        );
        if (input.entities.some((id) => !allowed.some((r) => r.id === id && r.kind === "page"))) {
          throw new Error("Entity references must be active pages in this scope.");
        }
        if (input.entities.length) {
          metadata.entities = input.entities;
        } else {
          delete metadata.entities;
        }
      }
      const extra = [...(input.addEvidence ?? []), ...annotationEvidence(metadata)];
      for (const evidence of extra) {
        inspectEvidence(path.join(this.config.root, scope), evidence);
      }
      if (extra.length) {
        metadata.evidence = [
          ...new Map(
            [...(metadata.evidence ?? []), ...extra].map((e) => [canonical(e), e]),
          ).values(),
        ];
      }
      const problems = annotationProblems(metadata, (id) =>
        data.records.filter((r) => r.id === id),
      );
      if (problems.length) {
        throw new Error(problems.join("; "));
      }
      const match = /^(?:\uFEFF)?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(previous.raw)!;
      const doc = parseDocument(match[1]!);
      for (const key of [
        "revision",
        "updated_at",
        ...Object.keys(input.annotations),
        ...(extra.length ? ["evidence"] : []),
      ]) {
        doc.set(
          key,
          // SAFETY: record metadata is parsed frontmatter, a plain object keyed by field name.
          doc.createNode((metadata as Record<string, unknown>)[key], {
            aliasDuplicateObjects: false,
          }),
        );
      }
      if (input.entities?.length) {
        doc.set("entities", doc.createNode(input.entities));
      } else if (input.entities) {
        doc.delete("entities");
      }
      doc.set("annotation_change", {
        reason: input.reason,
        actor,
        request_id: input.requestId,
        at: metadata.updated_at,
      });
      parseYaml(doc.toString());
      const raw = `---\n${doc.toString()}---\n${previous.body}`;
      const encoded = encodeRecordEvidence(
        { ...previous, metadata, raw, hash: digest(raw), revision: metadata.revision },
        (p) => readSourceDescriptor(path.join(this.config.root, scope), p),
      );
      const record = encoded.record;
      if (Buffer.byteLength(record.raw) > RECORD_MAX_BYTES) {
        throw new Error("Annotation exceeds record limits.");
      }
      if (new PublicationFiles(this.config.root).snapshot(scope) !== snapshot) {
        throw new Error("Edit conflict: vault changed during validation.");
      }
      return {
        previous,
        record,
        data,
        snapshot,
        artifacts: encoded.descriptors,
        requiredDescriptors: encoded.requiredDescriptors,
        annotation: true,
        annotationEvidence: extra,
        annotationReferences: input.entities,
      };
    });
    return this.accept(input.requestId, intent, prepared, access, actor);
  }
  /** Publishes or clears one owner-approved recall block through the normal journal. */
  async recall(
    input: Static<typeof RecallInput>,
    access: VaultAccess,
    actor: string,
  ): Promise<Receipt> {
    if (!Check(RecallInput, input)) {
      throw new Error("Invalid automatic recall input.");
    }
    access.assertCurrent();
    if (!this.config.writesEnabled) {
      throw new Error("Knowledge writes are disabled.");
    }
    const scope = scopeKey(access.scope),
      intent = digest(canonical({ operation: "recall", input }));
    const prior = this.store.withDatabase((db) => this.row(db, scope, input.requestId));
    if (prior) {
      this.checkReplay(prior, intent);
      return this.resume(access, input.requestId);
    }
    this.assertReadable();
    const prepared = await this.real.run(access, async (vault) => {
      const snapshot = new PublicationFiles(this.config.root).snapshot(scope),
        data = await vault.scan();
      // Recall can repair a malformed recall block, but not an otherwise ineligible record.
      const allowed = this.store.withDatabase((db) =>
        eligible(data, withdrawnIds(db, this.retrievalBinding(access)), false),
      );
      const previous = allowed.find(
        (record) => record.id === input.id && record.lifecycle === "active",
      );
      if (
        !previous ||
        previous.hash !== input.expectedHash ||
        previous.revision !== input.expectedRevision
      ) {
        throw new Error(
          "Automatic recall conflict: target is unavailable, inactive, invalid, or changed.",
        );
      }
      if (
        "set" in input &&
        previous.kind === "claim" &&
        ["source", "agent_inference"].includes(previous.metadata.assertion_origin ?? "")
      ) {
        throw new Error(
          "Automatic recall cannot approve externally sourced or agent-inferred claim text as owner context.",
        );
      }
      const now = new Date().toISOString();
      const metadata: Envelope = {
        ...previous.metadata,
        revision: previous.revision + 1,
        updated_at: now,
      };
      // Approval provenance is host-derived. The closed caller schema cannot supply these fields.
      if ("set" in input) {
        metadata.recall = {
          ...input.set,
          approved_by: "owner-private",
          approved_at: now,
        } satisfies Recall;
      } else {
        delete metadata.recall;
      }
      // Preserve authored YAML ordering, comments, and every unrelated unknown field.
      const match = /^(?:\uFEFF)?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(previous.raw)!;
      const doc = parseDocument(match[1]!);
      doc.set("revision", metadata.revision);
      doc.set("updated_at", metadata.updated_at);
      if (metadata.recall) {
        doc.set("recall", doc.createNode(metadata.recall, { aliasDuplicateObjects: false }));
      } else {
        doc.delete("recall");
      }
      parseYaml(doc.toString());
      const raw = `---\n${doc.toString()}---\n${previous.body}`;
      if (
        Buffer.byteLength(raw) > RECORD_MAX_BYTES ||
        !Check(Envelope, metadata) ||
        (metadata.recall !== undefined && !approvedRecall(metadata.recall))
      ) {
        throw new Error("Automatic recall metadata exceeds record limits or is invalid.");
      }
      const record: LoadedRecord = {
        ...previous,
        metadata,
        raw,
        hash: digest(raw),
        revision: metadata.revision,
      };
      if (new PublicationFiles(this.config.root).snapshot(scope) !== snapshot) {
        throw new Error("Edit conflict: vault changed during automatic recall validation.");
      }
      return { record, previous, data, snapshot, artifacts: {}, metadataOnly: true };
    });
    return this.accept(input.requestId, intent, prepared, access, actor);
  }
}
