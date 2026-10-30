import { randomUUID } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { Check } from "typebox/value";
import type { VaultAccess } from "./access.js";
import { BatchInput } from "./ingestion-contract.js";
import { SavePage, ClaimInput, RelationshipInput, type Receipt } from "./mutation-contract.js";
import { PublicationFiles } from "./publication-files.js";
import {
  RelinkInput,
  RELINK_EXAMPLES_MAX,
  type RelinkExample,
  type RelinkOutput,
} from "./relink-contract.js";
import { planRelink, relinkRequestId, unlinkedClaims } from "./relink.js";
import {
  RememberInput,
  REMEMBER_EXCERPT_MAX_BYTES,
  type RememberOutput,
} from "./remember-contract.js";
import { planRemember, claimPayload } from "./remember.js";
import { withdrawnIds, eligible } from "./retrieval.js";
import { StorageLifecycle } from "./storage-lifecycle.js";
import { canonical, scopeKey, type Prepared } from "./storage-types.js";
import { digest } from "./vault.js";

/** Why relink chose a subject, recorded as the annotation reason. */
const RELINK_BASIS = {
  page: "recorded source page",
  hint: "page named by the saver's subject hint",
  mention: "only entity named in the claim text",
} as const;
/** Multi-record ingestion: batches, remembered claims and subject relinking. */
export class StorageIngestion extends StorageLifecycle {
  async batch(input: BatchInput, access: VaultAccess, actor: string): Promise<Receipt> {
    if (!Check(BatchInput, input) || Buffer.byteLength(canonical(input)) > 1024 * 1024) {
      throw new Error(
        "Invalid batch input or batch exceeds 1 MiB. Use at most 25 records; retain originals with knowledge_attach.",
      );
    }
    access.assertCurrent();
    if (!this.config.writesEnabled || input.expectedVaultId !== this.config.vaultId) {
      throw new Error("Writes disabled or connected vault changed; no batch accepted.");
    }
    const scope = scopeKey(access.scope),
      intent = digest(canonical({ operation: "batch", input }));
    await this.initialize(access);
    const prior = this.store.withDatabase((db) => this.row(db, scope, input.requestId));
    if (prior) {
      this.checkReplay(prior, intent);
      return this.resume(access, input.requestId);
    }
    if (input.source) {
      const existing = await this.sourceCheck(input.source, access);
      if (existing.state === "unchanged") {
        return existing.receipt!;
      }
      if (existing.receipt?.requestId !== input.expectedPreviousRequestId) {
        throw new Error(
          "Source changed; reconcile the previous receipt and supply its requestId as expectedPreviousRequestId. No batch accepted.",
        );
      }
    } else if (input.expectedPreviousRequestId) {
      throw new Error("expectedPreviousRequestId requires source identity.");
    }
    this.assertReadable();
    const keys = new Map<string, string>();
    for (const item of input.items) {
      if (keys.has(item.key)) {
        throw new Error("Duplicate batch key.");
      }
      // A page edit targets an existing exact ID, never another local create.
      const id = item.kind === "page" ? item.input.id : undefined;
      if (id?.startsWith("@")) {
        throw new Error("Page edit id must be an existing stable ID.");
      }
      keys.set(item.key, id ?? randomUUID());
    }
    if (new Set(keys.values()).size !== keys.size) {
      throw new Error("A batch cannot edit the same record twice.");
    }
    const resolve = (value: unknown): unknown => {
      if (typeof value !== "string" || !value.startsWith("@")) {
        return value;
      }
      const id = keys.get(value.slice(1));
      if (!id) {
        throw new Error("Unknown local batch reference: " + value);
      }
      return id;
    };
    const prepared = await this.real.run(access, async (vault) => {
      const snapshot = new PublicationFiles(this.config.root).snapshot(scope),
        data = await vault.scan();
      const parts: Prepared[] = [];
      for (const item of input.items) {
        const value: Record<string, unknown> = structuredClone(item.input);
        for (const field of ["source_page", "owner", "from", "to"]) {
          if (value[field] !== undefined) {
            value[field] = resolve(value[field]);
          }
        }
        for (const field of ["entities", "dependencies"]) {
          if (Array.isArray(value[field])) {
            value[field] = value[field].map(resolve);
          }
        }
        if (Array.isArray(value.continuity)) {
          value.continuity = value.continuity.map((c) => ({ ...c, id: resolve(c.id) }));
        }
        if (value.identity && typeof value.identity === "object") {
          // SAFETY: identity is a non-null object, checked above; Check validates the resolved payload.
          const identity = value.identity as { candidates?: { id: string }[] };
          if (identity.candidates) {
            identity.candidates = identity.candidates.map((c) =>
              // SAFETY: batch references resolve to record IDs, which are strings.
              Object.assign(c, { id: resolve(c.id) as string }),
            );
          }
        }
        // Explicit template token, opt-in in authored body only; never rewrite retained evidence.
        if (typeof value.body === "string") {
          value.body = value.body.replace(
            /\[\[@([a-z][a-z0-9_-]{0,39})(\|[^\]\n]+)?\]\]/g,
            // SAFETY: batch references resolve to record IDs, which are strings.
            (_, key, label) => `[[${resolve("@" + key) as string}${label ?? ""}]]`,
          );
        }
        const payload = {
          ...value,
          requestId: input.requestId,
          expectedVaultId: input.expectedVaultId,
          expectedOntologyFingerprint: input.expectedOntologyFingerprint,
        };
        const schema =
          item.kind === "page" ? SavePage : item.kind === "claim" ? ClaimInput : RelationshipInput;
        if (!Check(schema, payload)) {
          throw new Error("Invalid resolved payload for batch item " + item.key);
        }
        // SAFETY: Check above validated the payload against this item's operation schema.
        const write = payload as SavePage & ClaimInput & RelationshipInput;
        if (
          Boolean(write.id) !== Boolean(write.expectedHash && write.expectedRevision) ||
          (!write.id && (write.expectedHash || write.expectedRevision))
        ) {
          throw new Error(
            "Page edits require id, expectedHash and expectedRevision; creates omit all three.",
          );
        }
        parts.push(
          await this.prepare(vault, write, item.kind, access, actor, undefined, undefined, {
            id: keys.get(item.key)!,
            data,
            snapshot,
          }),
        );
      }
      const records = parts.map((p) => p.record);
      if (new Set(records.map((r) => r.path)).size !== records.length) {
        throw new Error("Batch record path collision.");
      }
      // SAFETY: every part's artifacts are a record of file contents keyed by path.
      const artifacts = Object.assign({}, ...parts.map((p) => p.artifacts)) as Record<
        string,
        string
      >;
      const preview = await vault.scan({ records, artifacts });
      const active = this.store.withDatabase((db) =>
        eligible(preview, withdrawnIds(db, this.retrievalBinding(access)), false),
      );
      for (const record of records) {
        if (!record.valid) {
          throw new Error(
            "Batch validation failed for " +
              input.items[records.indexOf(record)]!.key +
              ": " +
              preview.issues
                .filter((i) => i.path === record.path)
                .map((i) => i.code)
                .join(", "),
          );
        }
        const m = record.metadata,
          refs = [
            ...(m.dependencies ?? []),
            ...(m.entities ?? []),
            ...[m.from, m.to, m.owner].filter((v): v is string => Boolean(v)),
          ];
        if (refs.some((id) => !active.some((r) => r.id === id))) {
          throw new Error("Batch reference unavailable or inactive in this scope.");
        }
      }
      if (
        input.source &&
        !records.some((r) => r.metadata.evidence?.some((e) => e.sha256 === input.source!.sha256))
      ) {
        throw new Error("Source hash must match retained evidence on a batch record.");
      }
      if (new PublicationFiles(this.config.root).snapshot(scope) !== snapshot) {
        throw new Error("Edit conflict: vault changed during batch validation.");
      }
      return {
        ...parts[0]!,
        artifacts,
        requiredDescriptors: Object.assign({}, ...parts.map((p) => p.requiredDescriptors ?? {})),
        additional: parts.slice(1).map((p) => ({ before: p.previous, after: p.record })),
        batch: {
          items: records.map((r, n) => ({
            key: input.items[n]!.key,
            id: r.id,
            path: r.path,
            revision: r.revision,
            hash: r.hash,
          })),
          source: input.source,
          expectedPreviousRequestId: input.expectedPreviousRequestId,
        },
      };
    });
    return this.accept(input.requestId, intent, prepared, access, actor);
  }
  /**
   * Save 1–20 conversation-derived claims in one call. Named subjects resolve
   * by exact ID/title/alias, omitted ones are inferred from one named entity
   * page; exact repeats return the saved claim; pages are never created. The excerpt is retained once through the attachment service and
   * every inserted claim cites it; inserts publish as one journaled batch.
   */
  async remember(
    input: RememberInput,
    access: VaultAccess,
    actor: string,
  ): Promise<RememberOutput> {
    if (
      !Check(RememberInput, input) ||
      !input.requestId ||
      Buffer.byteLength(input.excerpt) > REMEMBER_EXCERPT_MAX_BYTES ||
      !input.attribution.trim() ||
      input.items.some((i) => !i.text.trim())
    ) {
      throw new Error(
        "Invalid remember input: requestId, attribution, an excerpt of at most 16 KiB and 1–20 nonempty items are required.",
      );
    }
    access.assertCurrent();
    if (!this.config.writesEnabled) {
      throw new Error("Knowledge writes are disabled.");
    }
    if (input.expectedVaultId && input.expectedVaultId !== this.config.vaultId) {
      throw new Error("Connected vault changed; nothing was remembered.");
    }
    await this.initialize(access);
    const requestId = input.requestId,
      scope = scopeKey(access.scope);
    const { plan, fingerprint } = await this.run(access, async (vault) => {
      const data = await vault.scan(),
        withdrawn = this.store.withDatabase((db) =>
          withdrawnIds(db, this.retrievalBinding(access)),
        );
      return {
        plan: planRemember(data, eligible(data, withdrawn, false), input, withdrawn),
        fingerprint: data.ontology?.fingerprint,
      };
    });
    const prior = this.store.withDatabase((db) => this.row(db, scope, requestId));
    const inserts = plan.flatMap((p, n) => (p.duplicateOf || p.sameAs !== undefined ? [] : [n]));
    let receipt: Receipt | null = null;
    if (prior) {
      // A replay finds its own published claims as duplicates; keys map them back.
      receipt = this.resume(access, requestId);
      for (const item of receipt.items ?? []) {
        const n = Number(item.key.slice(1));
        if (!/^i\d+$/.test(item.key) || plan[n]?.duplicateOf !== item.id) {
          throw new Error(
            "Request ID already belongs to a different payload. Use the original payload for retries.",
          );
        }
        delete plan[n]!.duplicateOf;
      }
    } else if (inserts.length) {
      if (!fingerprint) {
        throw new Error("The ontology is unavailable; nothing was remembered.");
      }
      const upload = await this.attach(
        {
          requestId,
          expectedVaultId: this.config.vaultId,
          filename: "excerpt.txt",
          mediaType: "text/plain",
          attribution: input.attribution,
          offset: 0,
          data: Buffer.from(input.excerpt).toString("base64"),
          final: true,
        },
        access,
      );
      const evidence = {
        ...upload.evidence!,
        start_line: 1,
        end_line: input.excerpt.split(/\r?\n/).length,
      };
      receipt = await this.batch(
        {
          requestId,
          expectedVaultId: this.config.vaultId,
          expectedOntologyFingerprint: fingerprint,
          items: inserts.map((n) => ({
            key: `i${n}`,
            kind: "claim" as const,
            input: claimPayload(input.items[n]!, plan[n]!, evidence, input.attribution),
          })),
        },
        access,
        actor,
      );
    }
    const inserted = new Map((receipt?.items ?? []).map((i) => [Number(i.key.slice(1)), i.id]));
    const items = plan.map((p, n) => {
      const first = p.sameAs ?? n,
        saved = inserted.get(first);
      const { duplicateOf, sameAs: _sameAs, ...subject } = p;
      return Object.assign(
        {
          status: saved && first === n ? ("inserted" as const) : ("duplicate" as const),
          id: saved ?? duplicateOf ?? plan[first]!.duplicateOf!,
        },
        subject,
      );
    });
    const unlinked = items.filter(
        (i) => i.subject === "ambiguous" || i.subject === "missing",
      ).length,
      inferred = items.filter((i) => i.subject === "inferred").length;
    return {
      items,
      receipt,
      message: `${items.filter((i) => i.status === "inserted").length} saved, ${items.filter((i) => i.status === "duplicate").length} already saved${inferred ? `, ${inferred} linked by inference from the text` : ""}${unlinked ? `, ${unlinked} unlinked because the subject did not match exactly one page` : ""}. A published receipt is a completed save.`,
    };
  }
  /** Partitions present in this store: private and each conversation directory. */
  partitions(): import("./access.js").Partition[] {
    const found: import("./access.js").Partition[] = existsSync(
      path.join(this.config.root, "private"),
    )
      ? [{ visibility: "private" }]
      : [];
    const conversations = path.join(this.config.root, "conversations");
    if (existsSync(conversations)) {
      for (const entry of readdirSync(conversations, { withFileTypes: true })) {
        if (entry.isDirectory() && /^[a-f0-9-]{36}$/.test(entry.name)) {
          found.push({ visibility: "conversation", sessionId: entry.name });
        }
      }
    }
    return found;
  }
  /**
   * Link unlinked remembered claims to the one entity page each names, within
   * this partition only (gbrain facts relink, zero-LLM tiers). Each link is an
   * ordinary revision-fenced entities annotation with a stable request ID.
   */
  async relink(input: RelinkInput, access: VaultAccess, actor: string): Promise<RelinkOutput> {
    if (!Check(RelinkInput, input)) {
      throw new Error("Invalid relink input.");
    }
    access.assertCurrent();
    const dryRun = input.dryRun ?? false,
      limit = input.limit ?? 100,
      include = input.include ?? "remembered";
    // Relink writes only remembered claims; others were saved unlinked on purpose.
    if (include === "all" && !dryRun) {
      throw new Error('include: "all" lists claims for review and requires dryRun: true.');
    }
    if (!dryRun && !this.config.writesEnabled) {
      throw new Error("Knowledge writes are disabled.");
    }
    await this.initialize(access);
    const { plans, nextCursor } = await this.run(access, async (vault) => {
      const data = await vault.scan(),
        withdrawn = this.store.withDatabase((db) =>
          withdrawnIds(db, this.retrievalBinding(access)),
        );
      const active = eligible(data, withdrawn, false);
      const pending = unlinkedClaims(active, include).filter(
        (r) => input.cursor === undefined || r.id > input.cursor,
      );
      const batch = pending.slice(0, limit);
      return {
        plans: batch.map((r) => planRelink(data, active, withdrawn, r)),
        nextCursor: pending.length > limit ? batch[batch.length - 1]!.id : null,
      };
    });
    let failed = 0;
    const examples: RelinkExample[] = [],
      shown: Record<string, number> = {};
    for (const plan of plans) {
      let outcome: RelinkExample["outcome"] | "failed" = plan.outcome;
      if (plan.outcome === "linked" && !dryRun) {
        try {
          await this.annotate(
            {
              requestId: relinkRequestId(plan.record, plan.subject!.id),
              id: plan.record.id,
              expectedRevision: plan.record.revision,
              expectedHash: plan.record.hash,
              reason: `Relinked to ${plan.subject!.title} (${RELINK_BASIS[plan.tier!]}).`,
              annotations: {},
              entities: [plan.subject!.id],
            },
            access,
            actor,
          );
        } catch (e) {
          // A changed or conflicting claim stays unlinked; the next pass re-plans it.
          if (
            /authority|reloaded|assignment changed|disabled|identity or storage/i.test(
              // SAFETY: publication failures are Error instances.
              (e as Error).message,
            )
          ) {
            throw e;
          }
          failed++;
          outcome = "failed";
        }
      }
      if (outcome === "failed" || (shown[outcome] ?? 0) >= RELINK_EXAMPLES_MAX) {
        continue;
      }
      shown[outcome] = (shown[outcome] ?? 0) + 1;
      examples.push({
        id: plan.record.id,
        title: plan.record.title.slice(0, 200),
        outcome,
        ...(plan.tier ? { tier: plan.tier } : {}),
        ...(plan.subject
          ? { subject: { id: plan.subject.id, title: plan.subject.title.slice(0, 200) } }
          : {}),
        ...(plan.reason ? { reason: plan.reason } : {}),
      });
    }
    const count = (o: RelinkExample["outcome"]) => plans.filter((p) => p.outcome === o).length;
    const linked = count("linked") - failed,
      ambiguous = count("ambiguous"),
      noSubject = count("no_subject");
    const verb = dryRun ? "would link" : "linked";
    return {
      dryRun,
      scanned: plans.length,
      linked,
      ambiguous,
      noSubject,
      failed,
      examples,
      nextCursor,
      message: `${plans.length} unlinked remembered claims examined: ${linked} ${verb}, ${ambiguous} ambiguous, ${noSubject} with no entity page named${failed ? `, ${failed} not linked because the claim changed (retried next pass)` : ""}.${nextCursor ? " More remain; continue with nextCursor." : ""}`,
    };
  }
}
