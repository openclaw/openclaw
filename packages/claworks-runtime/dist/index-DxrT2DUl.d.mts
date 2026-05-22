import { R as IngressSource, S as LoadedPack, d as listNexusPackages, j as ClaworksRuntime, qt as A2aPeerConfig, r as NotifyChannelTarget, sn as CwEvent, x as CwPackConfig, yt as RobotOwner } from "./config-types-B21NhTMT.mjs";
import { Command } from "commander";

//#region src/claworks/observability.d.ts
type DecisionLogEntry = {
  id: string;
  at: string;
  playbookId?: string;
  runId?: string;
  stepId?: string;
  kind: string;
  summary: string;
  detail?: Record<string, unknown>;
};
type ObservationEvent = {
  id: string;
  at: string;
  source: string;
  type: string;
  payload: Record<string, unknown>;
};
declare function markRuntimeStarted(): void;
declare function runtimeUptimeSeconds(): number;
declare function appendDecisionLog(entry: Omit<DecisionLogEntry, "id" | "at">): void;
declare function listDecisionLog(limit?: number): DecisionLogEntry[];
declare function appendObservationEvent(source: string, type: string, payload: Record<string, unknown>): void;
declare function listObservationEvents(limit?: number): ObservationEvent[];
declare function prometheusMetricsText(robotName: string): string;
//#endregion
//#region src/claworks/product-env.d.ts
/** Default ClaWorks gateway port (OpenClaw default is 18789). */
declare const CLAWORKS_DEFAULT_GATEWAY_PORT = 18800;
declare function isClaworksProduct(env?: NodeJS.ProcessEnv): boolean;
/**
 * 判断环境变量是否指向 ClaWorks 专属路径
 * (.claworks 目录或 claworks.json 配置路径)
 */
declare function looksLikeClaworksStateEnv(env: Partial<NodeJS.ProcessEnv>): boolean;
declare function warnIfOpenClawEntryWithClaworksState(env?: Partial<NodeJS.ProcessEnv>): void;
/**
 * Isolate ClaWorks from a co-installed OpenClaw:
 * - state/config under ~/.claworks (not ~/.openclaw)
 * - default gateway port 18800
 * Call before config path resolution (entry + claworks.mjs wrapper).
 */
declare function applyClaworksProductEnv(env?: NodeJS.ProcessEnv): void;
/** Detect `claworks` CLI invocation and enable product mode. */
declare function detectAndApplyClaworksCli(env?: NodeJS.ProcessEnv): void;
//#endregion
//#region src/claworks/ingress-publish.d.ts
type IngressPublishParams = {
  source: IngressSource;
  eventType: string;
  subjectId: string;
  payload: Record<string, unknown>;
  correlationId?: string;
  subjectType?: CwEvent["subjectType"];
  idempotencyKey?: string; /** kernel.publish 的 source 字段（默认 subjectId） */
  publishSource?: string;
};
type IngressPublishResult = {
  action: "denied";
  reason: string;
} | {
  action: "observe_only";
} | {
  action: "intent_routed";
  playbookId: string;
  runId: string;
  status: string;
} | {
  action: "published";
  eventType: string;
  matchedPlaybooks: string[];
};
declare function applyIngressPublish(runtime: ClaworksRuntime, params: IngressPublishParams): Promise<IngressPublishResult>;
//#endregion
//#region src/claworks/rbac-sync.d.ts
declare function syncRbacFromObjectStore(runtime: ClaworksRuntime): Promise<void>;
/**
 * IngressPolicy 同样从 ObjectStore 加载后刷新 runtime.ingress。
 */
declare function syncIngressFromObjectStore(runtime: ClaworksRuntime): Promise<void>;
//#endregion
//#region src/claworks/policy-sync.d.ts
/**
 * Debounced sync of RBAC/Ingress policies after ObjectStore writes.
 */
declare function schedulePolicySync(runtime: ClaworksRuntime, typeName: string): void;
//#endregion
//#region src/claworks/doctor.d.ts
type DoctorCheck = {
  id: string;
  status: "ok" | "warn" | "error";
  message: string | null;
};
declare function runClaworksDoctor(runtime: ClaworksRuntime): DoctorCheck[];
//#endregion
//#region src/claworks/health.d.ts
type ClaworksHealthStatus = "ok" | "degraded" | "unavailable";
declare function resolveHealthStatus(checks: DoctorCheck[]): ClaworksHealthStatus;
declare function buildHealthPayload(runtime: ClaworksRuntime): {
  status: ClaworksHealthStatus;
  robot: string;
  role: "monolith" | "twin" | "ops" | "nexus";
  version: string;
  uptime_s: number;
  planes: {
    kernel: string;
    data: string;
    orch: string;
  };
  checks: DoctorCheck[];
};
//#endregion
//#region src/claworks/a2a-peer-auth.d.ts
type ResolvedA2aPeer = {
  peerId: string;
  subjectType: "peer";
  subjectId: string;
};
/** 从 metadata / source 解析对等机器人 ID。 */
declare function resolveA2aPeerId(meta: Record<string, unknown>): string | null;
declare function resolveA2aPeer(meta: Record<string, unknown>, configuredPeers: A2aPeerConfig[]): ResolvedA2aPeer | {
  error: string;
};
declare function checkA2aPeerRbac(runtime: ClaworksRuntime, peer: ResolvedA2aPeer, action: "a2a.delegate" | "event.publish", resource: string): {
  allowed: true;
} | {
  allowed: false;
  reason: string;
};
//#endregion
//#region src/claworks/notify-targets.d.ts
/** 从 ObjectStore RobotOwner + robot.md Owner 解析通知目标。 */
declare function resolveNotifyTargets(runtime: ClaworksRuntime, channelId: string): Promise<NotifyChannelTarget[]>;
declare function robotOwnerFromObject(row: Record<string, unknown>): RobotOwner | null;
//#endregion
//#region src/claworks/im-bridge.d.ts
type ImBridgeInput = {
  /** IM 频道标识，例如 feishu | weixin-work | dingtalk */channel: string; /** 平台原始消息 ID（用于幂等性） */
  messageId: string; /** 用户 ID（平台内） */
  userId: string; /** 消息纯文本内容 */
  text: string; /** 群组 / 会话 ID（可选） */
  groupId?: string; /** 附加元数据（图片 URL、文件、@ 列表等） */
  extra?: Record<string, unknown>;
};
type ImBridgeResult = {
  action: "denied";
  reason: string;
} | {
  action: "observe_only";
} | {
  action: "skipped";
  reason: string;
} | {
  action: "intent_routed";
  playbookId: string;
  runId: string;
  status: string;
} | {
  action: "published";
  eventType: string;
  matchedPlaybooks: string[];
};
declare function bridgeImMessage(runtime: ClaworksRuntime, input: ImBridgeInput): Promise<ImBridgeResult>;
//#endregion
//#region src/claworks/webhook-bridge.d.ts
type WebhookBridgeInput = {
  /** 逻辑来源标识（MES、SCADA、自定义集成名） */source: string; /** 幂等 ID（可选，默认生成） */
  webhookId?: string; /** 载荷：对象或 JSON 字符串 */
  body: Record<string, unknown> | string; /** 调用方主体（用于 RBAC，默认 webhook:source） */
  subjectId?: string;
  extra?: Record<string, unknown>;
};
type WebhookBridgeResult = {
  action: "denied";
  reason: string;
} | {
  action: "observe_only";
} | {
  action: "intent_routed";
  playbookId: string;
  runId: string;
  status: string;
} | {
  action: "published";
  eventType: string;
  matchedPlaybooks: string[];
};
declare function bridgeWebhookPayload(runtime: ClaworksRuntime, input: WebhookBridgeInput): Promise<WebhookBridgeResult>;
//#endregion
//#region src/claworks/im-channel-hook.d.ts
declare function bridgeChannelMessageReceived(runtime: ClaworksRuntime, params: {
  channelId: string;
  conversationId?: string;
  senderId?: string;
  messageId?: string;
  text: string;
  metadata?: Record<string, unknown>;
}): Promise<void>;
//#endregion
//#region src/claworks/pack-runtime.d.ts
declare function resolvePacksInstallRoot(): string;
declare function resolveInstalledStatePath(): string;
declare function loadPersistedInstalled(): Promise<string[]>;
declare function persistInstalled(installed: string[]): Promise<void>;
declare function mergePackConfig(config: CwPackConfig | undefined, persisted: string[]): CwPackConfig;
declare function reloadClaworksPacks(runtime: ClaworksRuntime): Promise<void>;
declare function reloadClaworksPackById(runtime: ClaworksRuntime, packId: string): Promise<LoadedPack | null>;
declare function installClaworksPack(runtime: ClaworksRuntime, source: string): Promise<{
  pack: LoadedPack;
  installed: string[];
}>;
declare function uninstallClaworksPack(runtime: ClaworksRuntime, packId: string): Promise<string[]>;
/** Re-install pack from Nexus or local path (same as install; refreshes artifacts). */
declare function updateClaworksPack(runtime: ClaworksRuntime, source: string): Promise<{
  pack: LoadedPack;
  installed: string[];
}>;
declare function reloadClaworksPacksFromDisk(runtime: ClaworksRuntime): Promise<{
  packs: LoadedPack[];
}>;
declare function searchNexusPackages(runtime: ClaworksRuntime, q?: string): Promise<Awaited<ReturnType<typeof listNexusPackages>>>;
//#endregion
//#region src/claworks/packs-cli.d.ts
declare function registerClaworksPacksCli(program: Command): void;
//#endregion
export { DoctorCheck as A, detectAndApplyClaworksCli as B, ResolvedA2aPeer as C, ClaworksHealthStatus as D, resolveA2aPeerId as E, IngressPublishParams as F, ObservationEvent as G, looksLikeClaworksStateEnv as H, IngressPublishResult as I, listDecisionLog as J, appendDecisionLog as K, applyIngressPublish as L, schedulePolicySync as M, syncIngressFromObjectStore as N, buildHealthPayload as O, syncRbacFromObjectStore as P, runtimeUptimeSeconds as Q, CLAWORKS_DEFAULT_GATEWAY_PORT as R, robotOwnerFromObject as S, resolveA2aPeer as T, warnIfOpenClawEntryWithClaworksState as U, isClaworksProduct as V, DecisionLogEntry as W, markRuntimeStarted as X, listObservationEvents as Y, prometheusMetricsText as Z, bridgeWebhookPayload as _, persistInstalled as a, bridgeImMessage as b, reloadClaworksPacksFromDisk as c, searchNexusPackages as d, uninstallClaworksPack as f, WebhookBridgeResult as g, WebhookBridgeInput as h, mergePackConfig as i, runClaworksDoctor as j, resolveHealthStatus as k, resolveInstalledStatePath as l, bridgeChannelMessageReceived as m, installClaworksPack as n, reloadClaworksPackById as o, updateClaworksPack as p, appendObservationEvent as q, loadPersistedInstalled as r, reloadClaworksPacks as s, registerClaworksPacksCli as t, resolvePacksInstallRoot as u, ImBridgeInput as v, checkA2aPeerRbac as w, resolveNotifyTargets as x, ImBridgeResult as y, applyClaworksProductEnv as z };