import fs from "node:fs/promises";
import path from "node:path";
import AjvPkg from "ajv";
import { describe, expect, it } from "vitest";

const Ajv = AjvPkg as unknown as new (opts?: object) => import("ajv").default;
const STRICT_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

async function loadSchema(name: string) {
  return JSON.parse(
    await fs.readFile(path.resolve("extensions/memory-wiki/schemas", name), "utf8"),
  ) as object;
}

function createAjv() {
  const ajv = new Ajv({ allErrors: true, strict: false });
  ajv.addFormat("date-time", {
    type: "string",
    validate: (value: string) => STRICT_DATE_TIME.test(value) && Number.isFinite(Date.parse(value)),
  });
  return ajv;
}

describe("memory-wiki JSON schemas", () => {
  it("enforces strict claim records with required statements and date-time fields", async () => {
    const validate = createAjv().compile(await loadSchema("claim.schema.json"));
    const validClaim = {
      claim_id: "claim.alpha",
      claim_key: "repo.openclaw.candidate.active",
      statement: "Candidate B is active.",
      text: "Candidate B is active.",
      status: "current",
      source_class: "operator",
      authority_tier: 3,
      asserted_at: "2026-05-21T00:00:00.000Z",
      extracted_at: "2026-05-21T00:00:00.000Z",
      valid_from: "2026-05-21T00:00:00.000Z",
      valid_until: null,
      supersedes: [],
      superseded_by: [],
      page_title: "Alpha",
      page_kind: "source",
      page_path: "sources/alpha.md",
      evidence_count: 1,
      missing_evidence: false,
      freshness_level: "fresh",
    };

    expect(validate(validClaim)).toBe(true);

    const missingStatement = { ...validClaim };
    delete (missingStatement as { statement?: string }).statement;
    expect(validate(missingStatement)).toBe(false);

    expect(validate({ ...validClaim, asserted_at: "2026-05-21" })).toBe(false);
    expect(validate({ ...validClaim, extra: true })).toBe(false);
  });

  it("enforces strict manifest hashes, metrics, and date-time fields", async () => {
    const validate = createAjv().compile(await loadSchema("wiki-cache-manifest.schema.json"));
    const validManifest = {
      manifest_version: 1,
      run_id: "wiki-cache-0123456789ab",
      pipeline_version: "memory-wiki-cache.v1",
      generated_at: "2026-05-21T00:00:00.000Z",
      source_import: {
        operation: "refresh",
        imported_count: 1,
        updated_count: 2,
        skipped_count: 3,
        removed_count: 0,
        artifact_count: 6,
        workspace_count: 2,
        page_path_count: 3,
        indexes_refreshed: true,
        index_refresh_reason: "import-changed",
      },
      claim_extraction: {
        extractor: "frontmatter.claims",
        claim_count: 1,
        statement_count: 1,
        missing_statement_count: 0,
      },
      compile: {
        page_count: 1,
        page_counts: { entity: 0, concept: 0, source: 1, synthesis: 0, report: 0 },
        managed_cache_file_count: 2,
      },
      freshness: {
        agent_digest_mtime: "2026-05-21T00:00:00.000Z",
        claims_jsonl_mtime: "2026-05-21T00:00:00.000Z",
        oldest_output_mtime: "2026-05-21T00:00:00.000Z",
        newest_output_mtime: "2026-05-21T00:00:00.000Z",
      },
      outputs: {
        agent_digest: { path: ".openclaw-wiki/cache/agent-digest.json", size_bytes: 100 },
        claims_jsonl: { path: ".openclaw-wiki/cache/claims.jsonl", size_bytes: 50 },
      },
      hashes: {
        agent_digest_sha256: "a".repeat(64),
        claims_jsonl_sha256: "b".repeat(64),
      },
    };

    expect(validate(validManifest)).toBe(true);
    expect(
      validate({
        ...validManifest,
        hashes: { ...validManifest.hashes, claims_jsonl_sha256: "not-a-sha" },
      }),
    ).toBe(false);
    expect(validate({ ...validManifest, generated_at: "2026-05-21" })).toBe(false);
    expect(
      validate({
        ...validManifest,
        claim_extraction: { ...validManifest.claim_extraction, missing_statement_count: 1 },
      }),
    ).toBe(false);
  });

  it("enforces memory utilization receipt preflight, decision, and writeback fields", async () => {
    const validate = createAjv().compile(
      await loadSchema("memory-utilization-receipt.schema.json"),
    );
    const validReceipt = {
      run_id: "run.receipt.alpha",
      task: "Verify memory utilization receipt plumbing.",
      memory_preflight: {
        performed: true,
        wiki_injectable: true,
        reason_if_not: null,
        files_read: [".openclaw-wiki/cache/agent-digest.json"],
        claims_used: ["claim.alpha"],
      },
      decisions_influenced_by_memory: [
        "Used claim.alpha to keep the implementation scoped to memory-wiki.",
      ],
      writeback: {
        performed: false,
        paths: [],
      },
    };

    expect(validate(validReceipt)).toBe(true);
    expect(
      validate({
        ...validReceipt,
        memory_preflight: {
          performed: true,
          wiki_injectable: true,
          reason_if_not: null,
          files_read: ["memory/MEMORY.md"],
        },
      }),
    ).toBe(false);
    expect(
      validate({
        ...validReceipt,
        writeback: { performed: true },
      }),
    ).toBe(false);
    expect(validate({ ...validReceipt, extra: true })).toBe(false);
  });
});
