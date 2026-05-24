import { $t as StepLog, A as PackContribution, An as ConnectorStatus, At as extractOwnerFromMd, B as IngressSource, Bt as CapabilityDescriptor, C as CwPackConfig, Cn as RobotInfo, Ct as RbacCheckInput, D as PackLoader, Dn as ConnectorConfig, Dt as RobotOwner, En as ConnectorAutoStart, Et as RobotIdentity, Ft as createModelRouter, G as EvolutionSyncManager, Gt as ConnectorEventHandler, H as EvolutionExportData, Ht as ActionRegistration, I as DEFAULT_INGRESS_POLICIES, It as IntentMapping, Jt as PlaybookDefinition, K as ImportResult, Kt as ConnectorManager, L as IngressDecision, Lt as IntentRegistry, M as PackSdkContext, Mt as loadRobotMd, N as ClaworksRuntime, Nt as ModelRouter, O as PackManifest, On as ConnectorInboundMessage, Ot as buildRobotIdentity, Pt as ModelRouterConfig, Qt as PublishEventFn, R as IngressPolicy, Sn as KnowledgeBase, St as DEFAULT_RBAC_POLICIES, Tn as resolveConnectorConfigs, Tt as RbacPolicy, U as EvolutionHistoryEntry, Ut as ActionRegistry, V as createIngressRouter, Vt as ActionHandler, W as EvolutionPack, Xt as PlaybookStep, Yt as PlaybookRun, Zt as PlaybookStepContext, _ as NexusVersionDetail, _t as SubagentRunFn, a as parsePlaybookYaml, an as createOntologyEngine, b as resolveInstalledPackIds, bn as KbResult, bt as HitlGate, cn as createObjectStore, ct as createPlaybookEngine, d as listNexusPackages, dn as CwPreparedStatement, dt as LlmCompleteFn, en as StepMeta, f as parseNexusSource, fn as FieldDefinition, ft as NotifyFn, g as NexusPackageSummary, gt as StepFailedError, h as NexusPackageListResponse, ht as StepExecutorDeps, i as parseObjectTypeYaml, in as OntologyEngine, j as PackFactory, jt as extractRulesFromMd, k as HookDefinition, kn as ConnectorOutboundMessage, kt as createRbacGuard, ln as openDatabase$1, lt as ConnectorInvokeFn, m as NexusPackageDetail, mn as ValidationResult, mt as SkillRunFn, n as ClaworksNotifyConfig, nn as listA2aPeerNames, o as readPackManifest, on as CwObject, p as NexusArtifactDescriptor, pn as ObjectTypeDefinition, pt as ScriptRunFn, qt as ActionStep, r as NotifyChannelTarget, rn as resolveA2aTarget, s as NexusInstallSpec, sn as ObjectStore, st as PlaybookEngine, t as ClaworksRobotConfig, tn as A2aPeerConfig, u as installPackFromNexus, un as CwDatabase, ut as HitlSuspendedError, v as createPackLoader, vt as executePlaybookStep, w as LoadedPack, wn as ConnectorConfigInput, wt as RbacCheckResult, x as resolvePackDir, xt as createHitlGate, y as readPackManifestFromDir, yt as interpolate, z as IngressRouter, zt as CapabilityContext } from "./config-types-CnpeTEne.mjs";
import { $ as looksLikeClaworksStateEnv, A as ClaworksHealthStatus, B as repairClaworksJsonConfig, C as normalizeImBridgeInput, D as checkA2aPeerRbac, E as ResolvedA2aPeer, F as runClaworksDoctorFix, G as IngressPublishParams, H as schedulePolicySync, I as ProductConfigRepairResult, J as CLAWORKS_DEFAULT_GATEWAY_PORT, K as IngressPublishResult, L as discoverPackSourceDir, M as resolveHealthStatus, N as DoctorCheck, O as resolveA2aPeer, P as runClaworksDoctor, Q as isClaworksProductionMode, R as hasPackSourcesAvailable, S as bridgeImMessage, T as robotOwnerFromObject, U as syncIngressFromObjectStore, V as repairOtConnectorSimulateFlags, W as syncRbacFromObjectStore, X as detectAndApplyClaworksCli, Y as applyClaworksProductEnv, Z as isClaworksProduct, _ as WebhookBridgeInput, a as loadPersistedInstalled, at as listDecisionLog, b as ImBridgeInput, c as reloadClaworksPackById, ct as prometheusMetricsText, d as resolveInstalledStatePath, et as warnIfOpenClawEntryWithClaworksState, f as resolvePacksInstallRoot, g as bridgeChannelMessageReceived, h as updateClaworksPack, i as installClaworksPack, it as appendObservationEvent, j as buildHealthPayload, k as resolveA2aPeerId, l as reloadClaworksPacks, lt as runtimeUptimeSeconds, m as uninstallClaworksPack, n as registerClaworksPacksCli, nt as ObservationEvent, o as mergePackConfig, ot as listObservationEvents, p as searchNexusPackages, q as applyIngressPublish, r as applyPackContributions, rt as appendDecisionLog, s as persistInstalled, st as markRuntimeStarted, t as registerClaworksEvolutionCli, tt as DecisionLogEntry, u as reloadClaworksPacksFromDisk, v as WebhookBridgeResult, w as resolveNotifyTargets, x as ImBridgeResult, y as bridgeWebhookPayload, z as isClaworksRobotConfigPresent } from "./index-CRxRpsnq.mjs";
import { n as startClaworksRuntime, r as stopClaworksRuntime, t as createClaworksRuntime } from "./runtime-Cnk97S6F.mjs";
import { a as migrateClaworksSchema, c as OpenDatabaseResult, i as createKnowledgeBase, l as openDatabase, n as mesProductionDispatch, o as convertPlaceholders, r as createFileKnowledgeBase, s as isPostgresDatabaseUrl, t as publishWorkOrderCreated } from "./index-DENGrHYB.mjs";
import { n as executeFunction, t as evaluatePlaybookCondition } from "./index-TOxIg-eJ.mjs";
import { C as serveClaworksStudio, D as resolveAuthContext, E as checkRbac, O as createClaworksRestHandler, S as sendJson, T as checkClaworksApiAuth, _ as A2aTaskStatus, a as McpToolDef, b as parsePath, c as createA2aHttpHandler, d as buildA2aAgentCard, f as A2aAgentCard, g as A2aTaskSendRequest, h as A2aTask, i as CLAWORKS_MCP_TOOLS, l as A2aTaskStore, m as A2aMessagePart, n as extractPackBuffer, o as callClaworksMcpTool, p as A2aMessage, r as scanNexusCatalog, s as createMcpHttpHandler, t as createNexusServer, u as A2aClient, v as badRequest, w as AuthContext, x as readJsonBody, y as notFound } from "./index-Ds317g0y.mjs";
import { n as CwEventType, t as CW_EVENTS } from "./event-names-CHNhXOM0.mjs";

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
export { A2aAgentCard, A2aClient, A2aMessage, A2aMessagePart, A2aPeerConfig, A2aTask, A2aTaskSendRequest, A2aTaskStatus, A2aTaskStore, type ActionHandler, type ActionRegistration, type ActionRegistry, ActionStep, AuthContext, CLAWORKS_DEFAULT_GATEWAY_PORT, CLAWORKS_MCP_TOOLS, CW_EVENTS, type CapabilityContext, type CapabilityDescriptor, ClaworksHealthStatus, ClaworksNotifyConfig, ClaworksRobotConfig, ClaworksRuntime, ConnectorAutoStart, ConnectorConfig, ConnectorConfigInput, ConnectorEventHandler, ConnectorInboundMessage, ConnectorInvokeFn, ConnectorManager, ConnectorOutboundMessage, ConnectorStatus, CwDatabase, type CwEventType, CwObject, type CwPackConfig, CwPreparedStatement, DEFAULT_INGRESS_POLICIES, DEFAULT_RBAC_POLICIES, DecisionLogEntry, DoctorCheck, EvolutionExportData, EvolutionHistoryEntry, EvolutionPack, EvolutionSyncManager, FieldDefinition, HitlGate, HitlSuspendedError, type HookDefinition, ImBridgeInput, ImBridgeResult, ImportResult, type IngressDecision, type IngressPolicy, IngressPublishParams, IngressPublishResult, type IngressRouter, type IngressSource, type IntentMapping, type IntentRegistry, type KbResult, type KnowledgeBase, LlmCompleteFn, type LoadedPack, McpToolDef, ModelRouter, ModelRouterConfig, NexusArtifactDescriptor, type NexusInstallSpec, NexusPackageDetail, NexusPackageListResponse, NexusPackageSummary, NexusVersionDetail, NotifyChannelTarget, NotifyFn, ObjectStore, ObjectTypeDefinition, ObservationEvent, OntologyEngine, OpenDatabaseResult, PROMPT_PRIORITY, type PackContribution, type PackFactory, type PackLoader, type PackManifest, type PackSdkContext, PlaybookDefinition, PlaybookEngine, PlaybookRun, PlaybookStep, PlaybookStepContext, type ProductConfigRepairResult, type PromptSection, type PromptSectionPriority, PublishEventFn, RbacCheckInput, RbacCheckResult, RbacPolicy, ResolvedA2aPeer, RobotIdentity, type RobotInfo, RobotOwner, ScriptRunFn, SkillRunFn, StepExecutorDeps, StepFailedError, StepLog, StepMeta, SubagentRunFn, SystemPromptBuilder, ValidationResult, WebhookBridgeInput, WebhookBridgeResult, appendDecisionLog, appendObservationEvent, applyClaworksProductEnv, applyIngressPublish, applyPackContributions, badRequest, bridgeChannelMessageReceived, bridgeImMessage, bridgeWebhookPayload, buildA2aAgentCard, buildHealthPayload, buildRobotIdentity, callClaworksMcpTool, checkA2aPeerRbac, checkClaworksApiAuth, checkRbac, convertPlaceholders, createA2aHttpHandler, createBasePromptBuilder, createClaworksRestHandler, createClaworksRuntime, createFileKnowledgeBase, createHitlGate, createIngressRouter, createKnowledgeBase, createMcpHttpHandler, createModelRouter, createNexusServer, createObjectStore, createOntologyEngine, createPackLoader, createPlaybookEngine, createRbacGuard, detectAndApplyClaworksCli, discoverPackSourceDir, evaluatePlaybookCondition, executeFunction, executePlaybookStep, extractOwnerFromMd, extractPackBuffer, extractRulesFromMd, hasPackSourcesAvailable, installClaworksPack, installPackFromNexus, interpolate, isClaworksProduct, isClaworksProductionMode, isClaworksRobotConfigPresent, isPostgresDatabaseUrl, listA2aPeerNames, listDecisionLog, listNexusPackages, listObservationEvents, loadPersistedInstalled, loadRobotMd, looksLikeClaworksStateEnv, markRuntimeStarted, mergePackConfig, mesProductionDispatch, migrateClaworksSchema, normalizeImBridgeInput, notFound, openDatabase, openDatabase$1 as openSqliteDatabase, parseNexusSource, parseObjectTypeYaml, parsePath, parsePlaybookYaml, persistInstalled, prometheusMetricsText, publishWorkOrderCreated, readJsonBody, readPackManifest, readPackManifestFromDir, registerClaworksEvolutionCli, registerClaworksPacksCli, reloadClaworksPackById, reloadClaworksPacks, reloadClaworksPacksFromDisk, repairClaworksJsonConfig, repairOtConnectorSimulateFlags, resolveA2aPeer, resolveA2aPeerId, resolveA2aTarget, resolveAuthContext, resolveConnectorConfigs, resolveHealthStatus, resolveInstalledPackIds, resolveInstalledStatePath, resolveNotifyTargets, resolvePackDir, resolvePacksInstallRoot, robotOwnerFromObject, runClaworksDoctor, runClaworksDoctorFix, runtimeUptimeSeconds, scanNexusCatalog, schedulePolicySync, searchNexusPackages, sendJson, serveClaworksStudio, startClaworksRuntime, stopClaworksRuntime, syncIngressFromObjectStore, syncRbacFromObjectStore, uninstallClaworksPack, updateClaworksPack, warnIfOpenClawEntryWithClaworksState };