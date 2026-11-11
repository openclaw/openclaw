import { randomUUID } from "node:crypto";
import { runSqliteImmediateTransactionSync } from "openclaw/plugin-sdk/sqlite-worker-runtime";
import { Check } from "typebox/value";
import { isMap, parseDocument } from "yaml";
import type { VaultAccess } from "./access.js";
import { AUXILIARY_MAX_BYTES } from "./limits.js";
import type { Issue, Layout } from "./model.js";
import { LayoutInput, type Receipt } from "./mutation-contract.js";
import { parseOntology, resolveOntology, type OntologySource } from "./ontology.js";
import { PublicationFiles, type FileChange } from "./publication-files.js";
import { StorageIngestion } from "./storage-ingestion.js";
import { blocked, canonical, scopeKey, type Plan } from "./storage-types.js";
import { digest } from "./vault.js";

const ACTIVE = "ontology.yaml";
// The manifest the first layout save creates when the vault uses the bundled vocabulary.
const VAULT_MANIFEST = "vault";

/** The active manifest with one type's `layouts` entry set or removed; every other byte is kept where YAML allows. */
function withLayout(
  raw: string | null,
  sources: OntologySource[],
  type: string,
  layout: Layout | null,
) {
  if (raw === null) {
    if (sources.some((s) => s.manifest?.name === VAULT_MANIFEST)) {
      throw new Error(
        `An ontology named ${VAULT_MANIFEST} already exists in this vault; add the layout to ontology.yaml by hand.`,
      );
    }
    const doc = parseDocument(
      [
        "# This vault's vocabulary. The Knowledge UI saves page layouts here.",
        "format: knowledge-ontology-v1",
        `name: ${VAULT_MANIFEST}`,
        "version: 1.0.0",
        "description: Vocabulary changes saved for this vault.",
        "extends: knowledge-default",
        "definitions: []",
        "",
      ].join("\n"),
    );
    doc.setIn(["layouts", type], layout);
    return doc.toString({ lineWidth: 80 });
  }
  const doc = parseDocument(raw);
  if (doc.errors.length) {
    throw new Error("ontology.yaml cannot be parsed; fix it before editing layouts.");
  }
  if (layout) {
    doc.setIn(["layouts", type], layout);
  } else {
    doc.deleteIn(["layouts", type]);
    const remaining = doc.get("layouts");
    if (isMap(remaining) && !remaining.items.length) {
      doc.delete("layouts");
    }
  }
  return doc.toString({ lineWidth: 80 });
}

/** Operator layout edits: one journaled change to the vault's active ontology manifest. */
export class StorageLayouts extends StorageIngestion {
  async saveLayout(input: LayoutInput, access: VaultAccess, actor: string): Promise<Receipt> {
    if (!Check(LayoutInput, input)) {
      throw new Error("Invalid layout input.");
    }
    access.assertCurrent();
    if (input.expectedVaultId && input.expectedVaultId !== this.config.vaultId) {
      throw new Error("Connected vault changed; reload the vocabulary. Nothing was saved.");
    }
    if (!this.config.writesEnabled) {
      throw new Error("Knowledge writes are disabled.");
    }
    const scope = scopeKey(access.scope),
      intent = digest(canonical({ operation: "layout", input }));
    const prior = this.store.withDatabase((db) => this.row(db, scope, input.requestId));
    if (prior) {
      this.checkReplay(prior, intent);
      return this.resume(access, input.requestId);
    }
    this.assertReadable();
    const prepared = await this.real.run(access, async (vault) => {
      const data = await vault.scan(),
        ontology = data.ontology;
      if (!ontology) {
        throw new Error("The ontology is unavailable; resolve its issues before editing layouts.");
      }
      const current = ontology.definitions.find(
        (d) => d.definition.kind === "page" && d.definition.name === input.type,
      );
      if (!current) {
        throw new Error(`Unknown page type: ${input.type}.`);
      }
      if (canonical(current.definition.layout ?? null) !== canonical(input.expectedLayout)) {
        throw new Error(
          "This layout changed since it was opened; reload the vocabulary and edit again. Nothing was saved.",
        );
      }
      if (!input.layout && !current.layoutOverride) {
        throw new Error(`The ${input.type} layout already uses its default. Nothing was saved.`);
      }
      const before = data.sources.find((s) => s.path === ACTIVE)?.raw ?? null;
      const after = withLayout(before, data.sources, input.type, input.layout);
      // Publication refuses larger manifests after acceptance, which would block the store.
      if (Buffer.byteLength(after) > AUXILIARY_MAX_BYTES) {
        throw new Error(
          `ontology.yaml would exceed ${AUXILIARY_MAX_BYTES} bytes; shorten the layout. Nothing was saved.`,
        );
      }
      // Validate the result exactly as the next scan will resolve it.
      const issues: Issue[] = [];
      const resolved = resolveOntology(
        [...data.sources.filter((s) => s.path !== ACTIVE), parseOntology(ACTIVE, after, issues)],
        issues,
      );
      if (!resolved) {
        throw new Error(
          "The layout would make the ontology invalid: " +
            issues
              .map((i) => i.message)
              .join("; ")
              .slice(0, 600),
        );
      }
      // Layouts are outside the fingerprint, so in-flight writes stay valid.
      if (resolved.fingerprint !== ontology.fingerprint) {
        throw new Error("The layout edit would change validated definitions. Nothing was saved.");
      }
      return { before, after, fingerprint: ontology.fingerprint };
    });
    this.hook("before-accept");
    access.assertCurrent();
    this.store.withDatabase((db) => {
      const rival = this.row(db, scope, input.requestId);
      if (rival) {
        this.checkReplay(rival, intent);
        return;
      }
      if (db.prepare("SELECT 1 FROM mutations WHERE state!='published' LIMIT 1").get()) {
        throw blocked();
      }
      const files = new PublicationFiles(this.config.root),
        before = this.identity(db, files),
        target = `${scope}/${ACTIVE}`;
      if (files.read(target) !== prepared.before) {
        throw new Error(
          "ontology.yaml changed during validation; reload the vocabulary and edit again. Nothing was saved.",
        );
      }
      const after = { ...before, generation: before.generation + 1, publicationId: randomUUID() };
      const changes: FileChange[] = [
        [target, prepared.before, prepared.after] as const,
        ["vault.json", files.read("vault.json"), JSON.stringify(after) + "\n"] as const,
      ].map(([path, old, raw], n) => ({
        path,
        before: old,
        after: raw,
        backup: `${scope}/.knowledge-history/${input.requestId}/${n}.before`,
        stage: `${scope}/.knowledge-history/${input.requestId}/${n}.stage`,
      }));
      const receipt: Receipt = {
        requestId: input.requestId,
        state: "accepted",
        id: "",
        path: ACTIVE,
        revision: 0,
        hash: digest(prepared.after),
        at: new Date().toISOString(),
        message: "Accepted for publication; not yet saved.",
        indexed: false,
        operation: "layout",
        reason: input.layout
          ? `Saved the ${input.type} page layout.`
          : `Reset the ${input.type} page layout to its default.`,
        ontologyFingerprint: prepared.fingerprint,
      };
      const plan: Plan = {
        activity: access.activity,
        rootIdentity: files.identity(),
        before,
        after,
        changes,
        actor,
        scope,
        records: [],
      };
      this.hook("before-accept-commit");
      access.assertCurrent();
      runSqliteImmediateTransactionSync(
        db,
        () => {
          const current = this.row(db, scope, input.requestId);
          if (current) {
            this.checkReplay(current, intent);
            return;
          }
          if (db.prepare("SELECT 1 FROM mutations WHERE state!='published' LIMIT 1").get()) {
            throw blocked();
          }
          this.assertCheckpoint(db, before);
          db.prepare("INSERT INTO mutations VALUES (?,?,?,?,?,?)").run(
            scope,
            input.requestId,
            intent,
            "accepted",
            JSON.stringify(plan),
            JSON.stringify(receipt),
          );
        },
        { operationLabel: "knowledge.layout.accept" },
      );
    });
    this.hook("after-accept");
    return this.resume(access, input.requestId);
  }
}
