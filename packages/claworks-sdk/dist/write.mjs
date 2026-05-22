import { objectTypeToYaml, playbookToYaml } from "./index.mjs";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
//#region src/write.ts
/**
* @claworks/sdk/write
*
* Node.js file-writing helpers for Pack authors.
* Import separately to avoid pulling `node:fs` into browser bundlers.
*/
/**
* Write a complete Pack directory tree to disk.
*
* Creates:
*   {outputDir}/pack.json
*   {outputDir}/ontology/types/{ObjectType.name}.yaml
*   {outputDir}/ontology/playbooks/{Playbook.id}.yaml
*/
async function writePack(outputDir, manifest, objectTypes, playbooks) {
	const typesDir = join(outputDir, "ontology", "types");
	const playbooksDir = join(outputDir, "ontology", "playbooks");
	mkdirSync(typesDir, { recursive: true });
	mkdirSync(playbooksDir, { recursive: true });
	writeFileSync(join(outputDir, "pack.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");
	for (const ot of objectTypes) writeFileSync(join(typesDir, `${ot.name}.yaml`), objectTypeToYaml(ot), "utf8");
	for (const pb of playbooks) writeFileSync(join(playbooksDir, `${pb.id}.yaml`), playbookToYaml(pb), "utf8");
}
//#endregion
export { writePack };
