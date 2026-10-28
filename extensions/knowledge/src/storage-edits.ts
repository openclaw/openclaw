import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
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
import { linkTargets, mergeRedirects } from "./merge.js";
import { approvedRecall, Envelope, type LoadedRecord, type Recall } from "./model.js";
import {
  AnnotateInput,
  ExtractSectionInput,
  SavePage,
  ClaimInput,
  RelationshipInput,
  RecallInput,
  type Receipt,
} from "./mutation-contract.js";
import { connectedPages, linkGraph, pageSections } from "./page-budget.js";
import {
  carryLinks,
  relinkClaim,
  sameCitation,
  sectionEvidence,
  verifyMovedLinks,
} from "./page-extract.js";
import { PublicationFiles } from "./publication-files.js";
import { recordPath } from "./record-path.js";
import { withinBudget } from "./response-budget.js";
import { withdrawnIds, eligible } from "./retrieval.js";
import { encodeRecordEvidence, readSourceDescriptor } from "./source-records.js";
import { StoragePublication } from "./storage-publication.js";
import { canonical, scopeKey, type Prepared } from "./storage-types.js";
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
  /**
   * Move one body section to a new or connected page in one publication: the
   * destination gains the section verbatim (links carried, cited evidence copied),
   * the source keeps its heading with a one-line summary and link, and claims the
   * section cites move their primary subject to the destination. Everything is
   * validated together before acceptance; any failure leaves every file unchanged.
   */
  async extractSection(input: ExtractSectionInput, access: VaultAccess): Promise<Receipt> {
    if (!Check(ExtractSectionInput, input) || !input.reason.trim()) {
      throw new Error("Invalid section extraction input.");
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
      intent = digest(canonical({ operation: "extractSection", input }));
    const prior = this.store.withDatabase((db) => this.row(db, scope, input.requestId));
    if (prior) {
      this.checkReplay(prior, intent);
      return this.resume(access, input.requestId);
    }
    this.assertReadable();
    const prepared = await this.real.run(access, async (vault): Promise<Prepared> => {
      const snapshot = new PublicationFiles(this.config.root).snapshot(scope),
        data = await vault.scan();
      if (data.ontology?.fingerprint !== input.expectedOntologyFingerprint) {
        throw new Error("Ontology changed; inspect the current definitions before extracting.");
      }
      const withdrawn = this.store.withDatabase((db) =>
        withdrawnIds(db, this.retrievalBinding(access)),
      );
      const current = eligible(data, withdrawn, false);
      const page = (fence: { id: string; expectedRevision: number; expectedHash: string }) => {
        const matches = data.records.filter((r) => r.id === fence.id),
          found = matches.length === 1 ? matches[0] : undefined;
        if (
          !found ||
          !found.valid ||
          found.kind !== "page" ||
          found.lifecycle !== "active" ||
          found.hash !== fence.expectedHash ||
          found.revision !== fence.expectedRevision ||
          !current.some((r) => r.id === found.id)
        ) {
          throw new Error(
            `Extraction conflict: page ${fence.id} is unavailable, inactive or changed. Reread it and retry with a new request. No publication accepted.`,
          );
        }
        return found;
      };
      const source = page(input.source);
      const section = pageSections(source.body).find((s) => s.start === input.sectionStart);
      if (!section) {
        throw new Error(
          `No section heading starts at offset ${input.sectionStart} of ${source.title}. Use a section start from a fresh full read or a page-budget rejection. No publication accepted.`,
        );
      }
      const graph = linkGraph(data.records, current);
      const target = "id" in input.destination ? page(input.destination) : undefined;
      if (target && target.id === source.id) {
        throw new Error("A section cannot be extracted to its own page.");
      }
      if (target && !connectedPages(graph, source.id).some((r) => r.id === target.id)) {
        throw new Error(
          `${target.title} is not connected to ${source.title} by a body link or typed relationship. Extract to a new page, or to a connected page the section is about. No publication accepted.`,
        );
      }
      const create = "id" in input.destination ? undefined : input.destination;
      const definition = create
        ? data.ontology?.definitions.find(
            (d) => d.definition.name === create.type && d.definition.kind === "page",
          )?.definition
        : undefined;
      if (create && !definition) {
        throw new Error("Choose a valid page type from the current ontology.");
      }
      const destinationId = target?.id ?? randomUUID(),
        destinationTitle = target?.title ?? create!.title;
      const destinationPath =
        target?.path ??
        recordPath(definition!.directory, create!.title, destinationId, (candidate) =>
          existsSync(path.join(this.config.root, scope, candidate)),
        );
      const original = source.body.slice(section.start, section.end);
      const moved = carryLinks(source.body, section, source.path, destinationPath, graph.targets);
      const text = moved.text.endsWith("\n") ? moved.text : moved.text + "\n";
      const join = (body: string) =>
        body + (!body || body.endsWith("\n\n") ? "" : body.endsWith("\n") ? "\n" : "\n\n") + text;
      // prepare() adds each citation once, next to any the destination already has.
      const carried = [...sectionEvidence(source, original), ...(input.evidence ?? [])];
      const fences = {
        requestId: input.requestId,
        expectedVaultId: input.expectedVaultId,
        expectedOntologyFingerprint: input.expectedOntologyFingerprint,
      };
      const heading = section.heading || "section";
      const batch = { data, snapshot };
      const destination = await this.prepare(
        vault,
        {
          ...fences,
          ...(target
            ? {
                id: target.id,
                expectedRevision: target.revision,
                expectedHash: target.hash,
                title: target.title,
                body: join(target.body),
              }
            : {
                title: create!.title,
                type: create!.type,
                ...(create!.aliases ? { aliases: create!.aliases } : {}),
                body: text,
              }),
          ...(carried.length ? { attachments: carried } : {}),
          // SAFETY: a page save reads only these SavePage fields; the combined preview validates the result.
        } as SavePage & ClaimInput & RelationshipInput,
        "page",
        access,
        "agent",
        undefined,
        undefined,
        { ...batch, id: destinationId },
        target
          ? `Received section "${heading}" from ${source.title} (${source.id}): ${input.reason}`.slice(
              0,
              2000,
            )
          : undefined,
      );
      if (destination.record.path !== destinationPath) {
        throw new Error("Edit conflict: destination path changed during validation.");
      }
      // The heading stays so the outline survives; one summary line links the new home.
      const headingEnd = source.body.indexOf("\n", section.start),
        headingLine = source.body.slice(
          section.start,
          headingEnd === -1 || headingEnd > section.end ? section.end : headingEnd,
        );
      const label = destinationTitle.replace(/[[\]|\r\n]+/g, " ").trim();
      const stub = `${headingLine}\n\n${input.summary.trim()} See [[${destinationId}|${label}]].${/\n\s*\n$/.test(original) ? "\n\n" : "\n"}`;
      const shrunk = await this.prepare(
        vault,
        {
          ...fences,
          id: source.id,
          expectedRevision: source.revision,
          expectedHash: source.hash,
          title: source.title,
          body: source.body.slice(0, section.start) + stub + source.body.slice(section.end),
          // SAFETY: a page save reads only these SavePage fields; the combined preview validates the result.
        } as SavePage & ClaimInput & RelationshipInput,
        "page",
        access,
        "agent",
        undefined,
        undefined,
        { ...batch, id: source.id },
        `Extracted section "${heading}" to ${destinationTitle} (${destinationId}): ${input.reason}`.slice(
          0,
          2000,
        ),
      );
      // Claims the section cites that name the source as a subject also belong to the destination.
      const at = new Date().toISOString();
      const claims = data.records
        .filter(
          (r) =>
            r.kind === "claim" &&
            moved.linked.has(r.id) &&
            r.metadata.entities?.includes(source.id) &&
            !r.metadata.entities.includes(destinationId) &&
            current.some((c) => c.id === r.id),
        )
        .map((before) => {
          const encoded = encodeRecordEvidence(
            relinkClaim(before, destinationId, {
              reason: `Section "${heading}" moved from ${source.title} to ${destinationTitle}.`,
              actor: "agent",
              requestId: input.requestId,
              at,
            }),
            (p) => readSourceDescriptor(path.join(this.config.root, scope), p),
          );
          return Object.assign(encoded, { before });
        });
      const records = [destination.record, shrunk.record, ...claims.map((c) => c.record)];
      const artifacts = { ...destination.artifacts, ...shrunk.artifacts },
        requiredDescriptors = {
          ...destination.requiredDescriptors,
          ...shrunk.requiredDescriptors,
        };
      for (const claim of claims) {
        Object.assign(artifacts, claim.descriptors);
        Object.assign(requiredDescriptors, claim.requiredDescriptors);
      }
      // Verify the destination as it will be read before the source text is removed.
      const preview = await vault.scan({ records, artifacts });
      const active = eligible(preview, withdrawn, false);
      for (const record of records) {
        const m = record.metadata,
          refs = [
            ...(m.dependencies ?? []),
            ...(m.entities ?? []),
            ...[m.owner, m.source_page].filter((v): v is string => Boolean(v)),
          ];
        if (!record.valid || refs.some((id) => !active.some((r) => r.id === id))) {
          throw new Error(
            `Extraction validation failed for ${record.title}: ` +
              preview.issues
                .filter((i) => i.path === record.path)
                .map((i) => i.code)
                .join(", "),
          );
        }
      }
      const after = linkTargets(preview.records, active),
        landed = destination.record;
      if (
        !landed.body.endsWith(text) ||
        carried.some((e) => !(landed.metadata.evidence ?? []).some((x) => sameCitation(x, e)))
      ) {
        throw new Error("Extraction verification failed; no publication accepted.");
      }
      verifyMovedLinks(moved, { source, shrunk: shrunk.record, target, landed }, after, {
        section,
        stubEnd: section.start + stub.length,
        appended: landed.body.length - text.length,
        destinationId,
      });
      if (new PublicationFiles(this.config.root).snapshot(scope) !== snapshot) {
        throw new Error("Edit conflict: vault changed during validation.");
      }
      return {
        record: landed,
        previous: target,
        data,
        snapshot,
        artifacts,
        requiredDescriptors,
        additional: [
          { before: source, after: shrunk.record },
          ...claims.map((c) => ({ before: c.before, after: c.record })),
        ],
        batch: {
          items: [
            { key: "destination", record: landed },
            { key: "source", record: shrunk.record },
          ].map(({ key, record }) => ({
            key,
            id: record.id,
            path: record.path,
            revision: record.revision,
            hash: record.hash,
          })),
        },
        extract: { targetId: source.id, reason: input.reason },
      };
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
