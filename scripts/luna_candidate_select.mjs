import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { readdir, stat } from "node:fs/promises";

const proofDir = process.env.PROOF_DIR;
const latestProof = process.env.LATEST_PROOF;

if (!proofDir || typeof proofDir !== "string") {
  console.error("PROOF_DIR is required");
  process.exit(2);
}
if (!latestProof || typeof latestProof !== "string") {
  console.error("LATEST_PROOF is required");
  process.exit(2);
}

let snapshotPath = join(latestProof, "inventory_snapshot.json");
let semanticPath = join(latestProof, "semantic_map.json");

const findLatestProofFiles = async (root) => {
  const stack = [root];
  let best = null;
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries = [];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      if (entry.isFile() && entry.name === "inventory_snapshot.json") {
        const semanticCandidate = join(dir, "semantic_map.json");
        if (!existsSync(semanticCandidate)) continue;
        const info = await stat(fullPath);
        if (!best || info.mtimeMs > best.mtimeMs) {
          best = { snapshot: fullPath, semantic: semanticCandidate, mtimeMs: info.mtimeMs };
        }
      }
    }
  }
  return best;
};

if (!existsSync(snapshotPath) || !existsSync(semanticPath)) {
  const found = await findLatestProofFiles(latestProof);
  if (!found) {
    console.error(`Missing snapshot/semantic map under: ${latestProof}`);
    process.exit(2);
  }
  snapshotPath = found.snapshot;
  semanticPath = found.semantic;
}

const snapshot = JSON.parse(await readFile(snapshotPath, "utf8"));
const semantic = JSON.parse(await readFile(semanticPath, "utf8"));
const byEntity = semantic.by_entity ?? {};
const entities = snapshot.entities ?? {};

const isNonActionable = (resolution) =>
  Boolean(resolution?.non_actionable) || String(resolution?.semantic_type ?? "").startsWith("telemetry.");

const pickCandidate = (semanticType, domainHint, fallbackDomain) => {
  for (const [entityId, resolution] of Object.entries(byEntity)) {
    if (!resolution || resolution.semantic_type !== semanticType) continue;
    if (isNonActionable(resolution)) continue;
    const entity = entities[entityId];
    if (!entity) continue;
    if (domainHint && entity.domain !== domainHint) continue;
    return entityId;
  }
  if (!fallbackDomain) return null;
  for (const [entityId, resolution] of Object.entries(byEntity)) {
    if (!resolution || resolution.semantic_type !== semanticType) continue;
    if (isNonActionable(resolution)) continue;
    const entity = entities[entityId];
    if (!entity) continue;
    if (entity.domain !== fallbackDomain) continue;
    return entityId;
  }
  return null;
};

const candidates = {
  light: pickCandidate("light", "light"),
  fan: pickCandidate("fan", "fan", null),
  outlet: pickCandidate("outlet", "switch") ?? pickCandidate("generic_switch", "switch"),
  vacuum: pickCandidate("vacuum", "vacuum", null),
  climate: pickCandidate("climate", "climate", null),
  lock: pickCandidate("lock", "lock", null),
  source: {
    snapshot: snapshotPath,
    semantic: semanticPath,
  },
};

await mkdir(join(proofDir, "luna_tests"), { recursive: true });
const outPath = join(proofDir, "luna_tests", "candidate_entities.json");
await writeFile(outPath, JSON.stringify(candidates, null, 2));

console.log(JSON.stringify(candidates, null, 2));
