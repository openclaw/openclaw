import { $t as ObjectStore, A as PackSdkContext, Bt as PlaybookDefinition, Ct as extractRulesFromMd, D as HookDefinition, Dt as createModelRouter, E as PackManifest, Et as ModelRouterConfig, F as IngressDecision, Ft as ActionRegistry, Gt as StepLog, Ht as PlaybookStep, I as IngressPolicy, Jt as listA2aPeerNames, Kt as StepMeta, L as IngressRouter, Lt as ConnectorEventHandler, Mt as CapabilityDescriptor, Nt as ActionHandler, O as PackContribution, Ot as IntentMapping, P as DEFAULT_INGRESS_POLICIES, Pt as ActionRegistration, Qt as CwObject, R as IngressSource, Rt as ConnectorManager, S as LoadedPack, Sn as ConnectorStatus, St as extractOwnerFromMd, T as PackLoader, Tt as ModelRouter, Ut as PlaybookStepContext, Vt as PlaybookRun, Wt as PublishEventFn, Xt as OntologyEngine, Yt as resolveA2aTarget, Zt as createOntologyEngine, _ as NexusVersionDetail, _n as resolveConnectorConfigs, _t as RbacPolicy, a as parsePlaybookYaml, an as ObjectTypeDefinition, at as NotifyFn, bn as ConnectorInboundMessage, bt as buildRobotIdentity, ct as StepFailedError, d as listNexusPackages, dt as interpolate, en as createObjectStore, et as PlaybookEngine, f as parseNexusSource, fn as KbResult, ft as HitlGate, g as NexusPackageSummary, gn as ConnectorConfigInput, gt as RbacCheckResult, h as NexusPackageListResponse, hn as RobotInfo, ht as RbacCheckInput, i as parseObjectTypeYaml, in as FieldDefinition, it as LlmCompleteFn, j as ClaworksRuntime, jt as CapabilityContext, k as PackFactory, kt as IntentRegistry, lt as SubagentRunFn, m as NexusPackageDetail, mn as KnowledgeBase, mt as DEFAULT_RBAC_POLICIES, n as ClaworksNotifyConfig, nn as CwDatabase, nt as ConnectorInvokeFn, o as readPackManifest, on as ValidationResult, ot as SkillRunFn, p as NexusArtifactDescriptor, pt as createHitlGate, qt as A2aPeerConfig, r as NotifyChannelTarget, rn as CwPreparedStatement, rt as HitlSuspendedError, s as NexusInstallSpec, st as StepExecutorDeps, t as ClaworksRobotConfig, tn as openDatabase$1, tt as createPlaybookEngine, u as installPackFromNexus, ut as executePlaybookStep, v as createPackLoader, vn as ConnectorAutoStart, vt as RobotIdentity, wt as loadRobotMd, x as CwPackConfig, xn as ConnectorOutboundMessage, xt as createRbacGuard, y as resolvePackDir, yn as ConnectorConfig, yt as RobotOwner, z as createIngressRouter, zt as ActionStep } from "./config-types-B21NhTMT.mjs";
import { A as DoctorCheck, B as detectAndApplyClaworksCli, C as ResolvedA2aPeer, D as ClaworksHealthStatus, E as resolveA2aPeerId, F as IngressPublishParams, G as ObservationEvent, H as looksLikeClaworksStateEnv, I as IngressPublishResult, J as listDecisionLog, K as appendDecisionLog, L as applyIngressPublish, M as schedulePolicySync, N as syncIngressFromObjectStore, O as buildHealthPayload, P as syncRbacFromObjectStore, Q as runtimeUptimeSeconds, R as CLAWORKS_DEFAULT_GATEWAY_PORT, S as robotOwnerFromObject, T as resolveA2aPeer, U as warnIfOpenClawEntryWithClaworksState, V as isClaworksProduct, W as DecisionLogEntry, X as markRuntimeStarted, Y as listObservationEvents, Z as prometheusMetricsText, _ as bridgeWebhookPayload, a as persistInstalled, b as bridgeImMessage, c as reloadClaworksPacksFromDisk, d as searchNexusPackages, f as uninstallClaworksPack, g as WebhookBridgeResult, h as WebhookBridgeInput, i as mergePackConfig, j as runClaworksDoctor, k as resolveHealthStatus, l as resolveInstalledStatePath, m as bridgeChannelMessageReceived, n as installClaworksPack, o as reloadClaworksPackById, p as updateClaworksPack, q as appendObservationEvent, r as loadPersistedInstalled, s as reloadClaworksPacks, t as registerClaworksPacksCli, u as resolvePacksInstallRoot, v as ImBridgeInput, w as checkA2aPeerRbac, x as resolveNotifyTargets, y as ImBridgeResult, z as applyClaworksProductEnv } from "./index-DxrT2DUl.mjs";
import { n as startClaworksRuntime, r as stopClaworksRuntime, t as createClaworksRuntime } from "./runtime-Cr4RdnwJ.mjs";
import { a as migrateClaworksSchema, c as OpenDatabaseResult, i as createKnowledgeBase, l as openDatabase, n as mesProductionDispatch, o as convertPlaceholders, r as createFileKnowledgeBase, s as isPostgresDatabaseUrl, t as publishWorkOrderCreated } from "./index-B3v6oX8F.mjs";
import { n as executeFunction, t as evaluatePlaybookCondition } from "./index-C4wEzron.mjs";
import { C as serveClaworksStudio, D as resolveAuthContext, E as checkRbac, O as createClaworksRestHandler, S as sendJson, T as checkClaworksApiAuth, _ as A2aTaskStatus, a as McpToolDef, b as parsePath, c as createA2aHttpHandler, d as buildA2aAgentCard, f as A2aAgentCard, g as A2aTaskSendRequest, h as A2aTask, i as CLAWORKS_MCP_TOOLS, l as A2aTaskStore, m as A2aMessagePart, n as extractPackBuffer, o as callClaworksMcpTool, p as A2aMessage, r as scanNexusCatalog, s as createMcpHttpHandler, t as createNexusServer, u as A2aClient, v as badRequest, w as AuthContext, x as readJsonBody, y as notFound } from "./index-A2g5wfIg.mjs";

//#region src/kernel/system-prompt-builder.d.ts
/**
 * system-prompt-builder.ts — ClaWorks 分段 System Prompt 构建器
 *
 * 参照 OpenClaw `src/agents/system-prompt.ts` 的分段架构，将 system prompt
 * 拆分为带优先级的具名段（sections），保证：
 *   1. 结构一致：每段独立，互不干扰
 *   2. 可缓存前缀：稳定段在前（低优先级数），动态段在后（高优先级数）
 *   3. 弱模型友好：简短段 + 明确指令，避免模型迷失
 *
 * 段优先级体系（数字越小越靠前）：
 *   P10  SOUL       —— 机器人核心身份/价值观（最稳定，缓存友好）
 *   P20  MEMORY     —— 注入的相关记忆片段
 *   P30  USER       —— 当前用户画像
 *   P40  CONTEXT    —— 近期对话摘要
 *   P50  CAPABILITIES —— 可用能力列表
 *   P60  SAFETY     —— 安全规则（不可违背）
 *   P70  OPERATOR   —— 运营商补充指令
 *   P80  DYNAMIC    —— 动态 / 实时注入（每次请求都可能变化）
 *
 * 使用示例：
 * ```ts
 * const prompt = new SystemPromptBuilder()
 *   .withSoul("R1", "工业巡检机器人，负责设备状态监控与报警响应")
 *   .withMemory(["上次P101报警原因：振动超标", "用户偏好简洁回复"])
 *   .withUserProfile({ name: "张工", style: "structured", topics: ["报警", "工单"] })
 *   .withCapabilities(["alarm.report", "workorder.create", "kb.search"])
 *   .build();
 * ```
 */
type PromptSectionPriority = number;
type PromptSection = {
  id: string;
  heading?: string;
  content: string; /** 越小越靠前（P10=Soul … P80=Dynamic）。默认 100。 */
  priority: PromptSectionPriority;
};
declare const PROMPT_PRIORITY: {
  readonly SOUL: 10;
  readonly MEMORY: 20;
  readonly USER: 30;
  readonly CONTEXT: 40;
  readonly CAPABILITIES: 50;
  readonly SAFETY: 60;
  readonly OPERATOR: 70;
  readonly DYNAMIC: 80;
};
declare class SystemPromptBuilder {
  private readonly _sections;
  /**
   * 添加或覆盖一个具名段。
   * id 唯一；同 id 再次调用会覆盖旧段。
   */
  addSection(id: string, content: string, opts?: {
    heading?: string;
    priority?: number;
  }): this;
  removeSection(id: string): this;
  hasSection(id: string): boolean;
  /**
   * Soul 段：机器人的核心身份与价值观。
   * 参照 OpenClaw context_files 中的 soul.md 文件角色。
   * 最稳定的段，缓存友好，每次请求不应改变。
   */
  withSoul(robotName: string, mission: string, extra?: string[]): this;
  /**
   * Memory 段：从向量搜索 / KB 检索到的相关记忆片段注入。
   * 参照 OpenClaw 的 `buildMemoryPromptSection`。
   */
  withMemory(memories: string[]): this;
  /**
   * User Profile 段：当前用户画像注入。
   * 来源：`UserProfileStore.toPromptHint(userId)`。
   */
  withUserProfile(profile: {
    name?: string;
    style?: string;
    language?: string;
    topics?: string[];
    interactionCount?: number;
    notes?: string;
  }): this;
  /**
   * Context 段：注入近期对话摘要（不是完整 history，用于 system prompt 感知连续性）。
   * 参照 OpenClaw 的 `extraSystemPrompt`（Group Chat Context）。
   */
  withContext(summary: string): this;
  /**
   * Capabilities 段：列出当前运行时可用的能力 ID。
   * 参照 OpenClaw 的 Tooling 段。
   * caps 超过 30 个时仅取前 30，避免 prompt 过长。
   */
  withCapabilities(caps: string[], extra?: string[]): this;
  /**
   * Safety 段：不可违背的安全规则。
   * 参照 OpenClaw 的 `safetySection`。
   */
  withSafetyRules(extra?: string[]): this;
  /**
   * Operator 段：运营商/管理员补充指令（来自 operator constitution Tier 1）。
   */
  withOperatorGuidance(guidance: string): this;
  /**
   * Dynamic 段：每次请求都可能变化的实时信息（当前时间、实时状态等）。
   * 参照 OpenClaw 的动态 context files（heartbeat.md 等）。
   * 放在 prompt 末尾，避免破坏稳定缓存前缀。
   */
  withDynamic(content: string): this;
  /**
   * 按优先级升序（小值在前）拼接所有段，返回完整 system prompt 字符串。
   * 每段格式：`## {heading}\n{content}\n`（有 heading 时）；无 heading 直接输出 content。
   */
  build(): string;
  /**
   * 导出当前所有段的快照（调试 / 测试用）。
   */
  sections(): ReadonlyArray<PromptSection>;
  /**
   * 克隆当前 builder（用于在同一基础上派生不同用户的 prompt）。
   */
  clone(): SystemPromptBuilder;
}
/**
 * 快速创建一个预设了 Soul + Safety 的基础 builder，
 * 供各能力处理器（perceive.intent 等）在此基础上追加动态段。
 */
declare function createBasePromptBuilder(opts: {
  robotName: string;
  mission: string;
  soulExtra?: string[];
  safetyExtra?: string[];
}): SystemPromptBuilder;
//#endregion
//#region src/claworks/product-config-repair.d.ts
type ProductConfigRepairResult = {
  changed: boolean;
  actions: string[];
  warnings: string[];
};
declare function discoverPackSourceDir(cwd?: string): string | null;
/** True when sibling claworks-packs, contrib/packs, or ~/.claworks/packs has at least one pack. */
declare function hasPackSourcesAvailable(opts?: {
  cwd?: string;
  stateDir?: string;
}): boolean;
declare function isClaworksRobotConfigPresent(config: Record<string, unknown>): boolean;
/** Seed ~/.claworks/robot.md from contrib/examples when missing. */
declare function seedRobotMdFromExample(opts?: {
  stateDir?: string;
  examplePath?: string;
}): {
  seeded: boolean;
  path: string;
  message: string | null;
};
/**
 * Full claworks.json repair: gateway port, plugins/packs/connectors, kb_provider, robot.md seed.
 * Mutates `config` in place (same object returned).
 */
declare function repairClaworksJsonConfig(config: Record<string, unknown>, opts?: {
  packSourceDir?: string | null;
  stateDir?: string;
  seedRobotMd?: boolean;
  enableEchoConnector?: boolean;
}): ProductConfigRepairResult & {
  robotMd?: ReturnType<typeof seedRobotMdFromExample>;
};
//#endregion
export { A2aAgentCard, A2aClient, A2aMessage, A2aMessagePart, A2aPeerConfig, A2aTask, A2aTaskSendRequest, A2aTaskStatus, A2aTaskStore, type ActionHandler, type ActionRegistration, type ActionRegistry, ActionStep, AuthContext, CLAWORKS_DEFAULT_GATEWAY_PORT, CLAWORKS_MCP_TOOLS, type CapabilityContext, type CapabilityDescriptor, ClaworksHealthStatus, ClaworksNotifyConfig, ClaworksRobotConfig, ClaworksRuntime, ConnectorAutoStart, ConnectorConfig, ConnectorConfigInput, ConnectorEventHandler, ConnectorInboundMessage, ConnectorInvokeFn, ConnectorManager, ConnectorOutboundMessage, ConnectorStatus, CwDatabase, CwObject, type CwPackConfig, CwPreparedStatement, DEFAULT_INGRESS_POLICIES, DEFAULT_RBAC_POLICIES, DecisionLogEntry, DoctorCheck, FieldDefinition, HitlGate, HitlSuspendedError, type HookDefinition, ImBridgeInput, ImBridgeResult, type IngressDecision, type IngressPolicy, IngressPublishParams, IngressPublishResult, type IngressRouter, type IngressSource, type IntentMapping, type IntentRegistry, type KbResult, type KnowledgeBase, LlmCompleteFn, type LoadedPack, McpToolDef, ModelRouter, ModelRouterConfig, NexusArtifactDescriptor, type NexusInstallSpec, NexusPackageDetail, NexusPackageListResponse, NexusPackageSummary, NexusVersionDetail, NotifyChannelTarget, NotifyFn, ObjectStore, ObjectTypeDefinition, ObservationEvent, OntologyEngine, OpenDatabaseResult, PROMPT_PRIORITY, type PackContribution, type PackFactory, type PackLoader, type PackManifest, type PackSdkContext, PlaybookDefinition, PlaybookEngine, PlaybookRun, PlaybookStep, PlaybookStepContext, type ProductConfigRepairResult, type PromptSection, type PromptSectionPriority, PublishEventFn, RbacCheckInput, RbacCheckResult, RbacPolicy, ResolvedA2aPeer, RobotIdentity, type RobotInfo, RobotOwner, SkillRunFn, StepExecutorDeps, StepFailedError, StepLog, StepMeta, SubagentRunFn, SystemPromptBuilder, ValidationResult, WebhookBridgeInput, WebhookBridgeResult, appendDecisionLog, appendObservationEvent, applyClaworksProductEnv, applyIngressPublish, badRequest, bridgeChannelMessageReceived, bridgeImMessage, bridgeWebhookPayload, buildA2aAgentCard, buildHealthPayload, buildRobotIdentity, callClaworksMcpTool, checkA2aPeerRbac, checkClaworksApiAuth, checkRbac, convertPlaceholders, createA2aHttpHandler, createBasePromptBuilder, createClaworksRestHandler, createClaworksRuntime, createFileKnowledgeBase, createHitlGate, createIngressRouter, createKnowledgeBase, createMcpHttpHandler, createModelRouter, createNexusServer, createObjectStore, createOntologyEngine, createPackLoader, createPlaybookEngine, createRbacGuard, detectAndApplyClaworksCli, discoverPackSourceDir, evaluatePlaybookCondition, executeFunction, executePlaybookStep, extractOwnerFromMd, extractPackBuffer, extractRulesFromMd, hasPackSourcesAvailable, installClaworksPack, installPackFromNexus, interpolate, isClaworksProduct, isClaworksRobotConfigPresent, isPostgresDatabaseUrl, listA2aPeerNames, listDecisionLog, listNexusPackages, listObservationEvents, loadPersistedInstalled, loadRobotMd, looksLikeClaworksStateEnv, markRuntimeStarted, mergePackConfig, mesProductionDispatch, migrateClaworksSchema, notFound, openDatabase, openDatabase$1 as openSqliteDatabase, parseNexusSource, parseObjectTypeYaml, parsePath, parsePlaybookYaml, persistInstalled, prometheusMetricsText, publishWorkOrderCreated, readJsonBody, readPackManifest, registerClaworksPacksCli, reloadClaworksPackById, reloadClaworksPacks, reloadClaworksPacksFromDisk, repairClaworksJsonConfig, resolveA2aPeer, resolveA2aPeerId, resolveA2aTarget, resolveAuthContext, resolveConnectorConfigs, resolveHealthStatus, resolveInstalledStatePath, resolveNotifyTargets, resolvePackDir, resolvePacksInstallRoot, robotOwnerFromObject, runClaworksDoctor, runtimeUptimeSeconds, scanNexusCatalog, schedulePolicySync, searchNexusPackages, sendJson, serveClaworksStudio, startClaworksRuntime, stopClaworksRuntime, syncIngressFromObjectStore, syncRbacFromObjectStore, uninstallClaworksPack, updateClaworksPack, warnIfOpenClawEntryWithClaworksState };