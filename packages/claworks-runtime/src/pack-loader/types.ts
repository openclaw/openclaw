import type { ObjectTypeDefinition } from "../planes/data/ontology-types.js";
import type { PlaybookDefinition } from "../planes/orch/playbook-types.js";

export interface PackManifest {
  id: string;
  name: string;
  version: string;
  description?: string;
  license: string;
  dependencies?: string[];
  provides: {
    objectTypes: string[];
    playbooks: string[];
    actionTypes: string[];
  };
}

export interface LoadedPack {
  manifest: PackManifest;
  path: string;
  objectTypes: ObjectTypeDefinition[];
  playbooks: PlaybookDefinition[];
}

export interface CwPackConfig {
  auto_load?: boolean;
  paths?: string[];
  installed?: string[];
  registry?: string;
}
