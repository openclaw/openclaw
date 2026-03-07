/**
 * validateDatasetIds.ts — Dataset ID collision validator.
 *
 * Scans all JSONL files across a brand's datasets and:
 *   1. Ensures every `id` field is globally unique
 *   2. Blocks duplicate IDs before append
 *   3. Auto-suggests next available ID on collision
 *   4. Validates ID format (brand prefix + type + number)
 *
 * Usage:
 *   npx ts-node brands/cutmv/engine/validators/validateDatasetIds.ts
 *   (or import validateIds / suggestNextId in pipeline code)
 */

import * as fs from "fs";
import * as path from "path";

// ── Types ──
interface IdEntry {
  id: string;
  file: string;
  line: number;
}

interface ValidationResult {
  valid: boolean;
  totalEntries: number;
  uniqueIds: number;
  duplicates: { id: string; locations: { file: string; line: number }[] }[];
  formatErrors: { id: string; file: string; line: number; reason: string }[];
}

// ── Helpers ──
function findJsonlFiles(dir: string): string[] {
  const results: string[] = [];
  if (!fs.existsSync(dir)) return results;

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...findJsonlFiles(fullPath));
    } else if (entry.name.endsWith(".jsonl")) {
      results.push(fullPath);
    }
  }
  return results;
}

function extractIds(files: string[]): IdEntry[] {
  const entries: IdEntry[] = [];
  for (const file of files) {
    const lines = fs.readFileSync(file, "utf-8").split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      try {
        const obj = JSON.parse(line);
        const id = obj.id || obj.content_id;
        if (id) {
          entries.push({ id, file, line: i + 1 });
        }
      } catch {
        // skip invalid JSON lines
      }
    }
  }
  return entries;
}

// ── ID format validator ──
const ID_PATTERN = /^(cmv|fd|cutmv|fulldigital)_[a-z]+_\d{4}$/;

function validateIdFormat(id: string): string | null {
  if (!ID_PATTERN.test(id)) {
    return `ID "${id}" does not match expected pattern: {brand}_{type}_{0000}`;
  }
  return null;
}

// ── Main validator ──
export function validateIds(brandDatasetDir: string): ValidationResult {
  const files = findJsonlFiles(brandDatasetDir);
  const entries = extractIds(files);

  // Check duplicates
  const idMap = new Map<string, { file: string; line: number }[]>();
  for (const entry of entries) {
    const existing = idMap.get(entry.id) || [];
    existing.push({ file: entry.file, line: entry.line });
    idMap.set(entry.id, existing);
  }

  const duplicates = Array.from(idMap.entries())
    .filter(([, locations]) => locations.length > 1)
    .map(([id, locations]) => ({ id, locations }));

  // Check format
  const formatErrors = entries
    .map((e) => {
      const reason = validateIdFormat(e.id);
      return reason ? { id: e.id, file: e.file, line: e.line, reason } : null;
    })
    .filter((e): e is NonNullable<typeof e> => e !== null);

  return {
    valid: duplicates.length === 0,
    totalEntries: entries.length,
    uniqueIds: idMap.size,
    duplicates,
    formatErrors,
  };
}

// ── Next ID suggester ──
export function suggestNextId(
  brandDatasetDir: string,
  prefix: string,
): string {
  const files = findJsonlFiles(brandDatasetDir);
  const entries = extractIds(files);

  const pattern = new RegExp(`^${prefix}_(\\d{4})$`);
  let maxNum = 0;

  for (const entry of entries) {
    const match = entry.id.match(pattern);
    if (match) {
      const num = parseInt(match[1], 10);
      if (num > maxNum) maxNum = num;
    }
  }

  const next = String(maxNum + 1).padStart(4, "0");
  return `${prefix}_${next}`;
}

// ── CLI runner ──
if (require.main === module) {
  const brandDir =
    process.argv[2] || path.resolve(__dirname, "../../datasets/copy");
  console.log(`\n🔍 Scanning: ${brandDir}\n`);

  const result = validateIds(brandDir);

  console.log(`   Total entries: ${result.totalEntries}`);
  console.log(`   Unique IDs:    ${result.uniqueIds}`);

  if (result.duplicates.length > 0) {
    console.log(`\n❌ DUPLICATE IDs FOUND:`);
    for (const dup of result.duplicates) {
      console.log(`   ${dup.id}:`);
      for (const loc of dup.locations) {
        console.log(`     → ${loc.file}:${loc.line}`);
      }
    }
  }

  if (result.formatErrors.length > 0) {
    console.log(`\n⚠️  FORMAT WARNINGS (${result.formatErrors.length}):`);
    for (const err of result.formatErrors) {
      console.log(`   ${err.id} → ${err.reason}`);
    }
  }

  if (result.valid && result.formatErrors.length === 0) {
    console.log(`\n✅ ALL VALID. Zero ID collisions. Zero format errors.`);
  }

  process.exit(result.valid ? 0 : 1);
}
