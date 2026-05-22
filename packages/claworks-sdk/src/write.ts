/**
 * @claworks/sdk/write
 *
 * Node.js file-writing helpers for Pack authors.
 * Import separately to avoid pulling `node:fs` into browser bundlers.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ObjectTypeDef, PackManifest, PlaybookDraft } from "./index.js";
import { objectTypeToYaml, playbookToYaml } from "./index.js";

/**
 * Write a complete Pack directory tree to disk.
 *
 * Creates:
 *   {outputDir}/pack.json
 *   {outputDir}/ontology/types/{ObjectType.name}.yaml
 *   {outputDir}/ontology/playbooks/{Playbook.id}.yaml
 */
export async function writePack(
  outputDir: string,
  manifest: PackManifest,
  objectTypes: ObjectTypeDef[],
  playbooks: PlaybookDraft[],
): Promise<void> {
  const typesDir = join(outputDir, "ontology", "types");
  const playbooksDir = join(outputDir, "ontology", "playbooks");

  mkdirSync(typesDir, { recursive: true });
  mkdirSync(playbooksDir, { recursive: true });

  writeFileSync(join(outputDir, "pack.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");

  for (const ot of objectTypes) {
    writeFileSync(join(typesDir, `${ot.name}.yaml`), objectTypeToYaml(ot), "utf8");
  }

  for (const pb of playbooks) {
    writeFileSync(join(playbooksDir, `${pb.id}.yaml`), playbookToYaml(pb), "utf8");
  }
}
