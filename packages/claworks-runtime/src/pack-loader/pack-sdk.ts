/**
 * pack-sdk.ts — ClaWorks Pack 开发者 SDK
 *
 * 第三方 Pack 开发者通过此 SDK 创建扩展，无需修改 ClaWorks 核心：
 *
 *   1. 只有 YAML（现有方式）— claworks.pack.json + ontology/
 *   2. YAML + JS 入口（混合模式）— YAML + index.ts/entry 字段
 *   3. 只有 JS（纯代码 Pack）— index.ts 导出 PackFactory
 *
 * ## Pack 的本质
 *
 * Pack **不是插件（Plugin）**。二者在软件工程中含义不同，不可混用：
 *
 *   - **Plugin（插件）**：向宿主进程注册可执行行为的代码模块。
 *     ClaWorks 生态中唯一的插件是 `extensions/claworks-robot`，
 *     它作为 OpenClaw Plugin 向 OpenClaw Gateway 注册机器人服务。
 *
 *   - **Pack（包/内容包）**：向 ClaWorks 机器人运行时贡献业务领域知识的
 *     内容包。主体是 YAML（Ontology、Playbook），可附带可选 TS 代码
 *     （`PackFactory`：actionHandlers、intentMappings、capabilities）。
 *     Pack 由 PackLoader 加载进运行时，不向任何宿主进程注册自身。
 *     类比：Ansible Role、Helm Chart、VS Code Extension Pack。
 *
 * Pack 贡献点（PackContribution）：
 *   - `playbooks`      — YAML Playbook 定义（主体，业务编排）
 *   - `objectTypes`    — YAML ObjectType 定义（领域本体/数据模型）
 *   - `capabilities`   — 可选代码：注册到 CapabilityRegistry 的额外能力
 *   - `actionHandlers` — 可选代码：处理 action 事件
 *   - `intentMappings` — 可选代码：IM 意图 → 事件路由
 *   - `scripts`        — 可选代码：纯代码脚本
 *   - `scaffolds`      — 可选代码：LLM 提示模板
 *   - `hooks`          — 可选代码：事件订阅
 *   - `onLoad` / `onUnload` — 生命周期钩子
 *
 * 使用示例：
 *
 * ```ts
 * // my-pack/index.ts
 * import type { PackFactory } from "@claworks/runtime";
 *
 * const factory: PackFactory = (runtime) => ({
 *   capabilities: [{ id: "my.action", ... }],
 *   onLoad: async (rt) => { console.log("my-pack loaded"); },
 * });
 *
 * export default factory;
 * ```
 */

import type { ClaworksRuntime } from "../claworks/runtime-types.js";
import type { ActionHandler } from "../kernel/action-registry.js";
import type { CapabilityDescriptor } from "../kernel/capability-registry.js";
import type { IntentMapping } from "../kernel/intent-registry.js";
import type { PromptTemplate } from "../kernel/prompt-templates.js";
import type { PackScriptEntry } from "../kernel/script-library.js";
import type { ObjectTypeDefinition } from "../planes/data/ontology-types.js";
import type { PlaybookDefinition } from "../planes/orch/playbook-types.js";
import type { ScaffoldTemplate } from "./types.js";

// ── Pack 贡献类型 ─────────────────────────────────────────────────────────

export type HookDefinition = {
  event: string;
  handler: (event: Record<string, unknown>) => void | Promise<void>;
};

export type PackContribution = {
  /**
   * 注册到能力注册表的额外能力。
   *
   * 对应 OpenClaw: `PluginToolMetadataRegistration`。
   * 文件系统加载：loader 从 claworks.pack.json provides.actionTypes 发现；
   * 代码注册：此字段在 factory 返回后追加，运行时动态注册。
   */
  capabilities?: CapabilityDescriptor[];

  /**
   * 注册到 Playbook 引擎的 Playbook 定义（代码方式）。
   *
   * 多数情况下通过 YAML 文件声明；此字段用于需要代码生成 Playbook 的场景。
   */
  playbooks?: PlaybookDefinition[];

  /** 注册到本体引擎的对象类型（代码方式）。 */
  objectTypes?: ObjectTypeDefinition[];

  /** 注册到 Prompt 模板注册表的模板。 */
  promptTemplates?: PromptTemplate[];

  /**
   * 通过代码注册的 LLM Scaffold 模板（对应文件系统 scaffolds/ 目录）。
   *
   * 适合运行时动态生成或参数化的 Scaffold；静态 Scaffold 推荐放 scaffolds/*.json 文件。
   *
   * 对应 OpenClaw: 无直接等价物；ClaWorks 特有的弱模型辅助机制。
   */
  scaffolds?: ScaffoldTemplate[];

  /**
   * 事件钩子（订阅内核事件总线）。
   *
   * 对应 OpenClaw: `PluginAgentEventSubscriptionRegistration`。
   */
  hooks?: HookDefinition[];

  /**
   * Playbook action 处理器映射（核心扩展点）。
   *
   * 对应 OpenClaw: `PluginSessionActionRegistration`。
   * 键为 action_api_name（与 Playbook YAML 中的 action 字段一致）。
   * 注册后，step-executor 优先调用此处理器，无需修改 runtime。
   *
   * 示例：
   * ```ts
   * actionHandlers: {
   *   "my-pack.create_task": async (params, ctx) => { ... return { id }; },
   *   "my-pack.update_status": handlers.updateStatus,
   * }
   * ```
   */
  actionHandlers?: Record<string, ActionHandler>;

  /**
   * IM 意图到业务事件的映射声明（解耦 function-executor 硬编码表）。
   *
   * 对应 OpenClaw: 无直接等价物；ClaWorks 特有的消息意图路由机制。
   * base Pack 只保留系统级 intent；业务 Pack 注册业务 intent。
   *
   * 示例：
   * ```ts
   * intentMappings: [
   *   { intent: "task_create", eventType: "task.create_requested", description: "用户请求创建任务" },
   *   { intent: "task_query", eventType: "task.status_query" },
   * ]
   * ```
   */
  intentMappings?: Array<Omit<IntentMapping, "packId">>;

  /**
   * Pack 声明的纯代码脚本（无需 LLM）。
   *
   * 对应 OpenClaw: 无直接等价物；ClaWorks 特有的代码原子能力注册机制。
   * Pack 加载时，loader 自动将其注册到 ScriptLibrary。
   * id 若不含 "." 则自动添加 `{packId}.` 前缀，避免命名冲突。
   *
   * 示例：
   * ```ts
   * scripts: [{
   *   id: "inspection-collector",  // 注册为 "my-pack.inspection-collector"
   *   name: "巡检数据收集",
   *   run: async (params, runtime) => {
   *     const items = await (runtime as ClaworksRuntime).objectStore?.query(...);
   *     return { items, count: items?.length ?? 0 };
   *   }
   * }]
   * ```
   */
  scripts?: PackScriptEntry[];

  /**
   * Pack 加载时执行（初始化连接/注册监听等）。
   *
   * 对应 OpenClaw: `PluginRuntimeLifecycleRegistration.onLoad`。
   */
  onLoad?: (runtime: ClaworksRuntime) => void | Promise<void>;

  /**
   * Pack 卸载时执行（清理资源）。
   *
   * 对应 OpenClaw: `PluginRuntimeLifecycleRegistration.onUnload`。
   */
  onUnload?: () => void | Promise<void>;

  /**
   * 依赖的其他 Pack ID 列表（loader 确保依赖先于本 Pack 加载）。
   *
   * 对应 OpenClaw: `PluginManifest.requires`。
   * 代码 Pack 中可在此声明，与 PackManifestV2.requires 等效。
   */
  dependsOn?: string[];

  /**
   * 要求的最低 ClaWorks 运行时版本（semver 字符串，如 "0.3.0"）。
   * loader 检查版本不满足时拒绝加载并记录警告。
   */
  minClaworksVersion?: string;
};

// ── Pack 清单（V2，支持 JS 入口）────────────────────────────────────────

export type PackManifestV2 = {
  id: string;
  name: string;
  version: string;
  description?: string;
  author?: string;
  license?: string;
  /** 依赖的其他 Pack ID 列表 */
  requires?: string[];
  /** JS/TS 入口文件（相对于 pack 目录，如 "index.js"） */
  entry?: string;
  /** 向后兼容：YAML 提供的能力列表 */
  provides?: {
    objectTypes?: string[];
    playbooks?: string[];
    actionTypes?: string[];
  };
};

// ── PackFactory 签名 ──────────────────────────────────────────────────────

/**
 * Pack 开发者导出的工厂函数签名。
 * Pack 的 index.ts/index.js 默认导出必须符合此类型。
 */
export type PackFactory = (
  runtime: ClaworksRuntime,
) => PackContribution | Promise<PackContribution>;

// ── Pack SDK 上下文（暴露给 Pack 开发者的工具集）────────────────────────

export type PackSdkContext = {
  runtime: ClaworksRuntime;
  /** 便捷方法：向 EventBus 发布事件 */
  publish(eventType: string, payload?: Record<string, unknown>): Promise<void>;
  /** 便捷方法：读取 KB */
  search(
    query: string,
    limit?: number,
  ): Promise<Array<{ id: string; content: string; score: number }>>;
  /** 便捷方法：写入 KB */
  ingest(content: string, metadata?: Record<string, unknown>): Promise<string>;
  /** 获取当前运行时配置 */
  config(): Record<string, unknown>;
};

export function createPackSdkContext(runtime: ClaworksRuntime): PackSdkContext {
  return {
    runtime,
    async publish(eventType, payload) {
      await runtime.kernel.publish(eventType, "pack-sdk", payload ?? {});
    },
    async search(query, limit = 5) {
      const results = await runtime.kb.search(query, { limit });
      return results.map((r) => ({ id: r.id, content: r.text, score: r.score ?? 0 }));
    },
    async ingest(content, metadata) {
      await runtime.kb.ingest(content, {
        source: (metadata?.source as string | undefined) ?? "pack-sdk",
        namespace: metadata?.namespace as string | undefined,
      });
      return "";
    },
    config() {
      return runtime.config as unknown as Record<string, unknown>;
    },
  };
}
