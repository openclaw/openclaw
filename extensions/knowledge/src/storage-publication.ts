import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { Check } from "typebox/value";
import { parseDocument, stringify } from "yaml";
import type { VaultAccess } from "./access.js";
import { annotationEvidence } from "./annotations.js";
import { AttachInput, ATTACHMENT_CHUNK_BYTES } from "./attachment-contract.js";
import { attachChunk } from "./attachments.js";
import { EvidenceInspector, inspectEvidence } from "./evidence-files.js";
import { parseYaml } from "./files.js";
import { lifecycleRecord, lifecycleImpact, assertLifecycleTarget } from "./lifecycle.js";
import { RECORD_MAX_BYTES } from "./limits.js";
import { mergeRedirects } from "./merge.js";
import { Envelope, RecordAnnotations, type LoadedRecord } from "./model.js";
import {
  SavePage,
  ClaimInput,
  RelationshipInput,
  CorrectInput,
  type WriteInput,
  type WriteKind,
  type Receipt,
} from "./mutation-contract.js";
import { DEFAULT_HUB_PERCENTILE, pageBudgetRejection } from "./page-budget.js";
import { PublicationFiles, type FileChange } from "./publication-files.js";
import { recordPath } from "./record-path.js";
import { withdrawnIds, eligible } from "./retrieval.js";
import {
  encodeRecordEvidence,
  readSourceDescriptor,
  recordSourceDependencies,
} from "./source-records.js";
import { StorageJournal } from "./storage-journal.js";
import {
  canonical,
  scopeKey,
  blocked,
  PageBudgetError,
  type Plan,
  type Prepared,
} from "./storage-types.js";
import type { SampleVault } from "./vault.js";
import { digest } from "./vault.js";
/** Validation and journaled acceptance of planned publications, plus single-record writes. */
export class StoragePublication extends StorageJournal {
  async attach(input: AttachInput, access: VaultAccess) {
    access.assertCurrent();
    if (!this.config.writesEnabled) {
      throw new Error("Knowledge writes are disabled.");
    }
    if (input.expectedVaultId && input.expectedVaultId !== this.config.vaultId) {
      throw new Error("Connected vault changed; do not upload this file here.");
    }
    await this.initialize(access);
    this.assertReadable();
    return this.transaction("knowledge.attach", (db) => {
      this.identity(db, new PublicationFiles(this.config.root));
      return attachChunk(
        db,
        this.config.root,
        scopeKey(access.scope),
        input,
        () => access.assertCurrent(),
        this.hook,
      );
    });
  }
  save(input: SavePage, access: VaultAccess, actor: string) {
    return this.publish(input, "page", access, actor);
  }
  createClaim(input: ClaimInput, access: VaultAccess, actor: string) {
    return this.publish(input, "claim", access, actor);
  }
  createRelationship(input: RelationshipInput, access: VaultAccess, actor: string) {
    return this.publish(input, "relationship", access, actor);
  }
  protected async publish(
    payload: WriteInput,
    kind: WriteKind,
    access: VaultAccess,
    actor: string,
    correction?: CorrectInput,
  ): Promise<Receipt> {
    const schema = kind === "page" ? SavePage : kind === "claim" ? ClaimInput : RelationshipInput;
    if (!Check(schema, payload)) {
      throw new Error("Invalid structured write input.");
    }
    // Unified preparation only after validating the operation-specific closed contract.
    // SAFETY: Check above validated the payload against the operation-specific contract.
    const input = payload as SavePage & ClaimInput & RelationshipInput;
    access.assertCurrent();
    if (input.expectedVaultId && input.expectedVaultId !== this.config.vaultId) {
      throw new Error(
        "Connected vault changed; this draft belongs to a different vault. No publication was accepted.",
      );
    }
    if (!this.config.writesEnabled) {
      throw new Error("Knowledge writes are disabled.");
    }
    if (
      Boolean(input.id) !== Boolean(input.expectedHash && input.expectedRevision) ||
      (!input.id && (input.expectedHash || input.expectedRevision))
    ) {
      throw new Error(
        "Create must omit id, expectedRevision and expectedHash; the server assigns the record ID. Edit requires all three from knowledge_record. expectedVaultId and expectedOntologyFingerprint are allowed on both. No publication accepted.",
      );
    }
    const scope = scopeKey(access.scope),
      intent = digest(
        canonical(
          correction
            ? { operation: "correct", input: correction }
            : kind === "page"
              ? input
              : { operation: kind, input },
        ),
      );
    const prior = this.store.withDatabase((db) => this.row(db, scope, input.requestId));
    if (prior) {
      this.checkReplay(prior, intent);
      return this.resume(access, input.requestId);
    }
    this.assertReadable();
    // Old clients may still submit source text. Large values use the same file
    // retention service; the page journal never needs to carry a large original.
    let sourceAttachment: import("./model.js").Evidence | undefined;
    if (input.source && Buffer.byteLength(input.source.text) > 65536) {
      const bytes = Buffer.from(input.source.text);
      for (let offset = 0; offset < bytes.length; offset += ATTACHMENT_CHUNK_BYTES) {
        const chunk = bytes.subarray(offset, offset + ATTACHMENT_CHUNK_BYTES);
        const receipt = await this.attach(
          {
            requestId: input.requestId,
            filename: "source.txt",
            mediaType: "text/plain",
            attribution: input.source.attribution,
            offset,
            data: chunk.toString("base64"),
            final: offset + chunk.length === bytes.length,
          },
          access,
        );
        sourceAttachment = receipt.evidence;
      }
    }
    const prepared = await this.real.run(access, (vault) =>
      this.prepare(vault, input, kind, access, actor, correction, sourceAttachment),
    );
    return this.accept(input.requestId, intent, prepared, access, actor);
  }
  protected async prepare(
    vault: SampleVault,
    input: SavePage & ClaimInput & RelationshipInput,
    kind: WriteKind,
    access: VaultAccess,
    actor: string,
    correction?: CorrectInput,
    sourceAttachment?: import("./model.js").Evidence,
    batch?: { id: string; data: Prepared["data"]; snapshot: string },
    bodyEditReason?: string,
  ): Promise<Prepared> {
    const scope = scopeKey(access.scope);
    const snapshot = batch?.snapshot ?? new PublicationFiles(this.config.root).snapshot(scope);
    const data = batch?.data ?? (await vault.scan());
    if (
      input.expectedOntologyFingerprint &&
      input.expectedOntologyFingerprint !== data.ontology?.fingerprint
    ) {
      throw new Error(
        "Ontology changed; inspect the current definitions before submitting a new request.",
      );
    }
    const corrected = correction
      ? assertLifecycleTarget(data.records, correction, true)
      : undefined;
    if (corrected && corrected.kind !== kind) {
      throw new Error("A correction must preserve record kind.");
    }
    const allowed = batch
      ? []
      : this.store.withDatabase((db) =>
          eligible(data, withdrawnIds(db, this.retrievalBinding(access)), false),
        );
    const references = [
      ...(input.dependencies ?? []),
      ...(input.entities ?? []),
      ...[input.from, input.to, input.owner].filter((id): id is string => Boolean(id)),
    ];
    const affected = corrected
      ? new Set([
          corrected.id,
          ...lifecycleImpact(data.records, corrected.id).items.map((r) => r.id),
        ])
      : undefined;
    if (affected && references.some((id) => affected.has(id))) {
      throw new Error("Replacement cannot depend on its superseded original.");
    }
    // A stale ID of a merged page must not quietly start a new fragment.
    const redirects = mergeRedirects(data.records),
      stale = [...references, ...(input.source_page ? [input.source_page] : [])].find((id) =>
        redirects.has(id),
      );
    if (stale) {
      throw new Error(
        `Reference ${stale} is a page that was merged into ${redirects.get(stale)}. Reference ${redirects.get(stale)} instead. No publication accepted.`,
      );
    }
    if (!batch && references.some((id) => !allowed.some((r) => r.id === id))) {
      throw new Error("Reference unavailable or inactive in this scope.");
    }
    if (
      !batch &&
      [
        ...(input.entities ?? []),
        ...[input.from, input.to, input.owner].filter((id): id is string => Boolean(id)),
      ].some((id) => !allowed.some((r) => r.id === id && r.kind === "page"))
    ) {
      throw new Error("Entity, owner and endpoint references must be pages.");
    }
    const matches = data.records.filter((r) => r.id === input.id);
    const previous = input.id && matches.length === 1 ? matches[0] : undefined;
    if (previous?.lifecycle === "merged") {
      throw new Error(
        `${previous.title} was merged into ${previous.metadata.merged_into}. Edit that page instead. No files were changed.`,
      );
    }
    if (
      input.id &&
      (!previous ||
        previous.lifecycle !== "active" ||
        !previous.valid ||
        previous.kind !== "page" ||
        previous.hash !== input.expectedHash ||
        previous.revision !== input.expectedRevision)
    ) {
      throw new Error(
        "Edit conflict: record changed, disappeared, is ambiguous, or is invalid. No files were changed by this request, and this draft was not saved. Retain your proposed text, reread the current record, and reconcile before creating a new request.",
      );
    }
    const type =
      kind === "claim"
        ? input.claim_kind
        : kind === "relationship"
          ? input.label
          : (input.type ?? previous?.type);
    const definition = data.ontology?.definitions.find(
      (d) => d.definition.name === type && d.definition.kind === kind,
    )?.definition;
    if (kind !== "claim" && !definition) {
      throw new Error("Choose a valid type from the current ontology.");
    }
    if (previous && type !== previous.type) {
      throw new Error("Type changes are not supported by this page editor.");
    }
    const now = new Date().toISOString(),
      id = previous?.id ?? batch?.id ?? randomUUID();
    const relative =
      previous?.path ??
      recordPath(
        kind === "claim" ? "claims/" : definition!.directory,
        input.title,
        id,
        (candidate) => existsSync(path.join(this.config.root, scope, candidate)),
      );
    const revision = (previous?.revision ?? 0) + 1;
    const metadata: Envelope = previous
      ? { ...previous.metadata, title: input.title, revision, updated_at: now }
      : {
          format: "knowledge-record-v1",
          id,
          revision,
          kind,
          title: input.title,
          scope: access.scope,
          ...(kind === "page" ? { type, fields: {} } : {}),
          recorded_at: now,
          updated_at: now,
          lifecycle: "active",
        };
    if (corrected && correction) {
      metadata.supersedes = corrected.id;
      metadata.lifecycle_change = {
        reason: correction.reason,
        at: now,
        actor,
        request_id: correction.requestId,
      };
    }
    // Legacy approval metadata has no meaning; remove it on the next journaled save.
    // SAFETY: record metadata is parsed frontmatter, a plain object keyed by field name.
    delete (metadata as Record<string, unknown>).acceptance;
    const portable = [
      ...Object.keys(RecordAnnotations.properties),
      "aliases",
      "tags",
      "dependencies",
      ...(kind === "page"
        ? []
        : ["attribution", "evidence", "valid_from", "valid_until", "expires_at"]),
      ...(kind === "claim"
        ? [
            "claim_kind",
            "assertion_origin",
            "entities",
            "subject_hint",
            "occurred_at",
            "owner",
            "due_at",
          ]
        : kind === "relationship"
          ? ["from", "to", "label"]
          : []),
    ];
    for (const key of portable) {
      // SAFETY: validated inputs and frontmatter metadata are plain objects keyed by field name.
      if ((input as Record<string, unknown>)[key] !== undefined) {
        // SAFETY: validated inputs and frontmatter metadata are plain objects keyed by field name.
        (metadata as Record<string, unknown>)[key] = (input as Record<string, unknown>)[key];
      }
    }
    if (kind !== "page" && !input.attribution.trim()) {
      throw new Error("Attribution must not be blank.");
    }
    if (input.fields !== undefined) {
      metadata.fields = input.fields;
    }
    if (input.attachments?.length) {
      metadata.evidence = [...(metadata.evidence ?? [])];
      for (const attachment of input.attachments) {
        inspectEvidence(path.join(this.config.root, scope), attachment);
        if (!metadata.evidence.some((e) => canonical(e) === canonical(attachment))) {
          metadata.evidence.push(attachment);
        }
      }
    }
    const artifacts: Record<string, string> = {};
    if (sourceAttachment) {
      metadata.evidence = [...(metadata.evidence ?? []), sourceAttachment];
      metadata.attribution = input.source!.attribution;
    }
    if (input.source && !sourceAttachment) {
      const artifact = `artifacts/${input.requestId}.txt`;
      artifacts[artifact] = input.source.text;
      metadata.evidence = [
        ...(metadata.evidence ?? []),
        {
          path: artifact,
          sha256: digest(input.source.text),
          attribution: input.source.attribution,
          start_line: 1,
          end_line: input.source.text.split(/\r?\n/).length,
        },
      ];
      // Attribution travels with the portable page, not only in the receipt.
      metadata.attribution = input.source.attribution;
    }
    const extra = annotationEvidence(metadata);
    if (extra.length) {
      metadata.evidence = [
        ...new Map([...(metadata.evidence ?? []), ...extra].map((e) => [canonical(e), e])).values(),
      ];
    }
    let yaml: string;
    if (previous) {
      const match = /^(?:\uFEFF)?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(previous.raw)!;
      const doc = parseDocument(match[1]!);
      doc.delete("acceptance");
      for (const key of [
        "title",
        "revision",
        "updated_at",
        // SAFETY: validated inputs are plain objects keyed by field name.
        ...portable.filter((field) => (input as Record<string, unknown>)[field] !== undefined),
        ...(input.fields !== undefined ? ["fields"] : []),
        ...(input.source
          ? ["evidence", "attribution"]
          : input.attachments?.length || extra.length
            ? ["evidence"]
            : []),
      ]) {
        doc.set(
          key,
          // SAFETY: record metadata is parsed frontmatter, a plain object keyed by field name.
          doc.createNode((metadata as Record<string, unknown>)[key], {
            aliasDuplicateObjects: false,
          }),
        );
      }
      if (bodyEditReason !== undefined) {
        doc.set("body_change", { reason: bodyEditReason, request_id: input.requestId, at: now });
      }
      yaml = doc.toString();
    } else {
      yaml = stringify(metadata, { aliasDuplicateObjects: false });
    }
    const raw = `---\n${yaml}---\n${input.body}`;
    // Validate the serialized representation too: annotation support may reuse
    // evidence objects, but the portable reader deliberately rejects aliases.
    parseYaml(yaml);
    if (!Check(Envelope, metadata)) {
      throw new Error("Record has invalid metadata.");
    }
    let record: LoadedRecord = {
      id,
      title: input.title,
      kind,
      type: type!,
      path: relative,
      revision,
      lifecycle: metadata.lifecycle,
      metadata,
      raw,
      body: input.body,
      hash: digest(raw),
      valid: true,
    };
    const encoded = encodeRecordEvidence(record, (p) =>
      readSourceDescriptor(path.join(this.config.root, scope), p),
    );
    record = encoded.record;
    Object.assign(artifacts, encoded.descriptors);
    if (Buffer.byteLength(record.raw) > RECORD_MAX_BYTES) {
      throw new Error("Record exceeds limits.");
    }
    if (!batch) {
      const preview = await vault.scan({ record, artifacts });
      if (!record.valid) {
        throw new Error(
          "Record validation failed: " +
            preview.issues
              .filter((i) => i.path === relative)
              .map((i) => i.code)
              .join(", "),
        );
      }
    }
    if (!batch && new PublicationFiles(this.config.root).snapshot(scope) !== snapshot) {
      throw new Error("Edit conflict: vault changed during validation.");
    }
    const additional =
      corrected && correction
        ? [
            {
              before: corrected,
              after: lifecycleRecord(corrected, "superseded", correction, actor, id),
            },
          ]
        : undefined;
    return {
      record,
      artifacts,
      requiredDescriptors: encoded.requiredDescriptors,
      previous,
      data,
      snapshot,
      additional,
      lifecycle: correction,
    };
  }
  protected accept(
    requestId: string,
    intent: string,
    prepared: Prepared,
    access: VaultAccess,
    actor: string,
  ): Receipt {
    const scope = scopeKey(access.scope);
    this.hook("before-accept");
    access.assertCurrent();
    // Every page-body write reaches this point, so the budget has one owner. The
    // transaction below fences the same snapshot the budget was measured against.
    const rejection = pageBudgetRejection({
      changes: [
        { before: prepared.previous, after: prepared.record },
        ...(prepared.additional ?? []),
      ],
      records: prepared.data.records,
      current: () =>
        this.store.withDatabase((db) =>
          eligible(prepared.data, withdrawnIds(db, this.retrievalBinding(access)), false),
        ),
      hubPercentile: this.config.hubPercentile ?? DEFAULT_HUB_PERCENTILE,
    });
    if (rejection) {
      const target = prepared.previous;
      throw new PageBudgetError({
        requestId,
        state: "rejected",
        id: target?.id ?? "",
        path: target?.path ?? "",
        revision: target?.revision ?? 0,
        hash: target?.hash ?? "",
        at: new Date().toISOString(),
        message: rejection.message,
        indexed: false,
        budget: rejection.budget,
      });
    }
    this.transaction("knowledge.accept", (db) => {
      const rival = this.row(db, scope, requestId);
      if (rival) {
        this.checkReplay(rival, intent);
        return;
      }
      if (db.prepare("SELECT 1 FROM mutations WHERE state!='published' LIMIT 1").get()) {
        throw blocked();
      }
      const files = new PublicationFiles(this.config.root),
        before = this.identity(db, files);
      if (files.snapshot(scope) !== prepared.snapshot) {
        throw new Error("Edit conflict: vault changed during validation.");
      }
      // A descriptor already read during preparation cannot disappear and be recreated.
      for (const [p, raw] of Object.entries(prepared.requiredDescriptors ?? {})) {
        if (readSourceDescriptor(path.join(this.config.root, scope), p) !== raw) {
          throw new Error("Source descriptor changed during validation.");
        }
      }
      // Fence the exact snapshot used for schema and reference validation.
      for (const r of prepared.data.records) {
        if (files.hash(`${scope}/${r.path}`) !== r.hash) {
          throw new Error("Edit conflict: vault changed during validation.");
        }
      }
      for (const source of prepared.data.sources.filter((s) => !s.path.startsWith("bundled:"))) {
        if (files.read(`${scope}/${source.path}`) !== source.raw) {
          throw new Error("Ontology changed during validation.");
        }
      }
      // Batches cite the same retained transcript many times; read each file once.
      const cited = new EvidenceInspector(path.join(this.config.root, scope));
      for (const evidence of prepared.annotation ||
      prepared.metadataOnly ||
      (prepared.lifecycle && !("replacement" in prepared.lifecycle))
        ? []
        : (prepared.record.metadata.evidence ?? [])) {
        if (!(evidence.path in prepared.artifacts)) {
          cited.inspect(evidence);
        }
      }
      for (const record of prepared.batch ? (prepared.additional ?? []).map((c) => c.after) : []) {
        for (const evidence of record.metadata.evidence ?? []) {
          cited.inspect(evidence);
        }
      }
      if (prepared.batch?.source) {
        const prior = this.sourceRow(db, scope, prepared.batch.source);
        if (prior?.request !== prepared.batch.expectedPreviousRequestId) {
          throw new Error("Source changed during validation; no batch accepted.");
        }
      }
      for (const evidence of prepared.annotationEvidence ?? []) {
        cited.inspect(evidence);
      }
      const stillActive = eligible(
        prepared.data,
        withdrawnIds(db, this.retrievalBinding(access)),
        false,
      );
      const m = prepared.record.metadata;
      const references = [
        ...(m.dependencies ?? []),
        ...(m.entities ?? []),
        ...[m.from, m.to, m.owner].filter((id): id is string => Boolean(id)),
      ];
      if (
        !prepared.batch &&
        !prepared.annotation &&
        !prepared.metadataOnly &&
        (!prepared.lifecycle || "replacement" in prepared.lifecycle) &&
        references.some((id) => !stillActive.some((r) => r.id === id))
      ) {
        throw new Error("Reference unavailable or inactive in this scope.");
      }
      if (
        prepared.annotationReferences?.some(
          (id) => !stillActive.some((r) => r.id === id && r.kind === "page"),
        )
      ) {
        throw new Error("Reference unavailable or inactive in this scope.");
      }
      // Bind every descriptor used for validation and every resulting record.
      // New sidecars are journaled; reused sidecars remain explicit replay dependencies.
      for (const record of prepared.data.records) {
        recordSourceDependencies(record, (p) =>
          readSourceDescriptor(path.join(this.config.root, scope), p),
        );
      }
      const descriptors: Record<string, string> = {};
      for (const record of [prepared.record, ...(prepared.additional ?? []).map((c) => c.after)]) {
        Object.assign(
          descriptors,
          recordSourceDependencies(
            record,
            (p) =>
              prepared.artifacts[p] ?? readSourceDescriptor(path.join(this.config.root, scope), p),
          ),
        );
      }
      const after = { ...before, generation: before.generation + 1, publicationId: randomUUID() };
      const changes: FileChange[] = [];
      const add = (target: string, old: string | null, raw: string) => {
        const n = changes.length;
        changes.push({
          path: target,
          before: old,
          after: raw,
          backup: `${scope}/.knowledge-history/${requestId}/${n}.before`,
          stage: `${scope}/.knowledge-history/${requestId}/${n}.stage`,
        });
      };
      for (const [p, raw] of Object.entries(prepared.artifacts)) {
        if (p.startsWith("artifacts/sources/")) {
          const existing = files.read(`${scope}/${p}`);
          if (existing !== null) {
            if (existing !== raw) {
              throw new Error("Immutable source descriptor changed.");
            }
            continue;
          }
        }
        add(`${scope}/${p}`, null, raw);
      }
      add(`${scope}/${prepared.record.path}`, prepared.previous?.raw ?? null, prepared.record.raw);
      for (const change of prepared.additional ?? []) {
        add(`${scope}/${change.after.path}`, change.before?.raw ?? null, change.after.raw);
      }
      add("vault.json", files.read("vault.json"), JSON.stringify(after) + "\n");
      for (const change of changes) {
        if (files.read(change.path) !== change.before) {
          throw new Error("Edit conflict: destination changed or already exists.");
        }
      }
      const receipt: Receipt = {
        requestId,
        state: "accepted",
        id: prepared.record.id,
        path: prepared.record.path,
        revision: prepared.record.revision,
        hash: prepared.record.hash,
        at: new Date().toISOString(),
        message: "Accepted for publication; not yet saved.",
        indexed: false,
      };
      if (prepared.batch) {
        receipt.items = prepared.batch.items;
      }
      if (prepared.lifecycle) {
        receipt.operation = "replacement" in prepared.lifecycle ? "correct" : "withdraw";
        receipt.targetId = prepared.lifecycle.id;
        if (receipt.operation === "correct") {
          receipt.replacementId = prepared.record.id;
        }
        receipt.reason = prepared.lifecycle.reason;
        receipt.impact = lifecycleImpact(prepared.data.records, prepared.lifecycle.id);
      }
      if (prepared.merge) {
        receipt.operation = prepared.merge.operation;
        receipt.targetId = prepared.merge.targetId;
        receipt.reason = prepared.merge.reason;
        receipt.merge = prepared.merge.report;
      }
      if (prepared.extract) {
        receipt.operation = "extract";
        receipt.targetId = prepared.extract.targetId;
        receipt.reason = prepared.extract.reason;
      }
      const changed = [prepared.record, ...(prepared.additional ?? []).map((c) => c.after)];
      if (prepared.supersede) {
        const { operation, by, reason, impact } = prepared.supersede;
        receipt.operation = operation;
        receipt.targetId = prepared.record.id;
        receipt.replacementId = by;
        receipt.reason = reason;
        receipt.items = changed.map((r) => ({
          key: operation === "supersede" ? "superseded" : "restored",
          id: r.id,
          path: r.path,
          revision: r.revision,
          hash: r.hash,
        }));
        if (impact) {
          receipt.impact = impact;
        }
      }
      const plan: Plan = {
        descriptors,
        activity: access.activity,
        rootIdentity: files.identity(),
        before,
        after,
        changes,
        actor,
        agentId: actor === "agent" ? access.agentId : undefined,
        scope,
        source: prepared.batch?.source,
        record: prepared.record,
        records: changed,
        ...(prepared.supersede?.operation === "unsupersede"
          ? { restored: changed.map((r) => r.id) }
          : {}),
      };
      access.assertCurrent();
      db.prepare("INSERT INTO mutations VALUES (?,?,?,?,?,?)").run(
        scope,
        requestId,
        intent,
        "accepted",
        JSON.stringify(plan),
        JSON.stringify(receipt),
      );
    });
    this.hook("after-accept");
    return this.resume(access, requestId);
  }
}
