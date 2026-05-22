import { ObjectTypeDef, PackManifest, PlaybookDraft } from "./index.mjs";

//#region src/write.d.ts
/**
 * Write a complete Pack directory tree to disk.
 *
 * Creates:
 *   {outputDir}/pack.json
 *   {outputDir}/ontology/types/{ObjectType.name}.yaml
 *   {outputDir}/ontology/playbooks/{Playbook.id}.yaml
 */
declare function writePack(outputDir: string, manifest: PackManifest, objectTypes: ObjectTypeDef[], playbooks: PlaybookDraft[]): Promise<void>;
//#endregion
export { writePack };