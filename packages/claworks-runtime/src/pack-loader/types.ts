import type { ObjectTypeDefinition } from "../planes/data/ontology-types.js";
import type { PlaybookDefinition } from "../planes/orch/playbook-types.js";
import type { PackFactory } from "./pack-sdk.js";

export interface PackDependency {
  /** Pack ID to depend on. */
  id: string;
  /** Semver range string, e.g. ">=0.1.0". Optional — omit to accept any version. */
  version?: string;
  /** If true, a missing dependency is a warning, not an error. Default false. */
  optional?: boolean;
}

export interface PackManifest {
  id: string;
  name: string;
  version: string;
  description?: string;
  license: string;
  /** @deprecated Use `requires` instead. Legacy flat string dependency list. */
  dependencies?: string[];
  /**
   * Structured dependency declarations.
   * Validated by the loader before activating a pack.
   */
  requires?: PackDependency[];
  /**
   * JS/TS 入口文件（相对于 pack 目录），默认导出必须为 PackFactory。
   * 例如: "./src/capabilities.js"
   */
  entry?: string;
  provides: {
    objectTypes: string[];
    playbooks: string[];
    actionTypes: string[];
    capabilities?: string[];
  };
}

export interface PackDependencyError {
  packId: string;
  dependencyId: string;
  reason: string;
}

/**
 * SkillModule — Pack skills/ 目录下加载的技能模块元数据。
 * 实际函数通过 factory / actionRegistry 注册。
 */
export interface SkillModule {
  /** 技能 ID（文件名去掉 .skill.ts/.skill.js 后缀） */
  id: string;
  /** 技能文件完整路径 */
  filePath: string;
  /** 所属 Pack ID */
  packId: string;
}

/**
 * ScaffoldTemplate — Pack scaffolds/ 目录下的弱模型辅助提示词脚本。
 */
export interface ScaffoldTemplate {
  /** 脚本 ID（来自 JSON 的 id 字段） */
  id: string;
  description?: string;
  prompt_template: string;
  output_schema?: Record<string, unknown>;
  output_parser?: string;
  output_parser_config?: Record<string, unknown>;
  recommended_models?: string[];
  max_tokens?: number;
  temperature?: number;
  examples?: Array<{ input: Record<string, unknown>; output: Record<string, unknown> }>;
  /** 所属 Pack ID */
  packId: string;
}

export interface LoadedPack {
  manifest: PackManifest;
  path: string;
  objectTypes: ObjectTypeDefinition[];
  playbooks: PlaybookDefinition[];
  /**
   * 当 manifest.entry 存在时，动态 import 并缓存的 PackFactory。
   * pack-runtime.ts 在获得 runtime 后调用此 factory 注册能力。
   */
  factory?: PackFactory;
  /** skills/ 目录下发现的技能模块列表 */
  skills?: SkillModule[];
  /** scaffolds/ 目录下解析的提示词脚本列表 */
  scaffolds?: ScaffoldTemplate[];
}

export interface CwPackConfig {
  auto_load?: boolean;
  paths?: string[];
  installed?: string[];
  registry?: string;
}

export interface PackLoader {
  load(packPath: string, logger?: (msg: string) => void): Promise<LoadedPack>;
  loadInstalled(config: CwPackConfig, logger?: (msg: string) => void): Promise<LoadedPack[]>;
  install(
    source: string,
    config: CwPackConfig,
    logger?: (msg: string) => void,
  ): Promise<LoadedPack>;
  list(): LoadedPack[];
}
