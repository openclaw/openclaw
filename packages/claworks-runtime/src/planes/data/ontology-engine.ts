import type { LoadedPack } from "../../pack-loader/index.js";
import type { ObjectTypeDefinition, ValidationResult } from "./ontology-types.js";

export interface OntologyEngine {
  loadFromPacks(packs: LoadedPack[]): Promise<void>;
  reloadPack(packId: string, pack: LoadedPack): Promise<void>;
  getType(name: string): ObjectTypeDefinition | null;
  listTypes(): ObjectTypeDefinition[];
  validate(typeName: string, data: Record<string, unknown>): ValidationResult;
  /** 运行时动态注册类型定义（供 ontology.bootstrap_* capabilities 使用）。 */
  registerType(def: ObjectTypeDefinition): void;
}

export function createOntologyEngine(): OntologyEngine {
  const types = new Map<string, ObjectTypeDefinition>();

  return {
    async loadFromPacks(packs: LoadedPack[]) {
      types.clear();
      for (const pack of packs) {
        for (const ot of pack.objectTypes) {
          types.set(ot.name, ot);
        }
      }
    },

    async reloadPack(packId, pack) {
      for (const [name, def] of types.entries()) {
        if (def.pack === packId) {
          types.delete(name);
        }
      }
      for (const ot of pack.objectTypes) {
        types.set(ot.name, ot);
      }
    },

    getType(name: string) {
      return types.get(name) ?? null;
    },

    listTypes() {
      return [...types.values()];
    },

    validate(typeName: string, data: Record<string, unknown>): ValidationResult {
      const def = types.get(typeName);
      if (!def) {
        return { valid: true, errors: [] };
      }
      const errors: ValidationResult["errors"] = [];
      for (const field of def.fields) {
        if (field.name === def.primaryKey) {
          continue;
        }
        if (field.required && (data[field.name] === undefined || data[field.name] === null)) {
          errors.push({ field: field.name, message: "required" });
        }
      }
      return { valid: errors.length === 0, errors };
    },

    registerType(def: ObjectTypeDefinition) {
      types.set(def.name, def);
    },
  };
}
