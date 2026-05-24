import { Ct as RbacCheckInput, N as ClaworksRuntime, O as PackManifest } from "./config-types-CnpeTEne.mjs";
import { IncomingMessage, ServerResponse, createServer } from "node:http";

//#region src/interfaces/rest/router.d.ts
declare function createClaworksRestHandler(runtime: ClaworksRuntime): (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;
//#endregion
//#region src/interfaces/rest/auth.d.ts
type AuthContext = {
  authenticated: boolean;
  subjectType: RbacCheckInput["subjectType"];
  subjectId: string;
};
declare function resolveAuthContext(req: IncomingMessage, runtime: ClaworksRuntime): AuthContext;
/** 旧版兼容：只返回 boolean（内部模块仍可用） */
declare function checkClaworksApiAuth(req: IncomingMessage, runtime: ClaworksRuntime): boolean;
/**
 * RBAC 权限检查（非 HTTP 中间件，作为函数调用）。
 * 返回 denied 时，调用方负责发 403 并发布 rbac.denied 事件（供 Playbook 响应）。
 */
declare function checkRbac(runtime: ClaworksRuntime, auth: AuthContext, action: string, resource: string): {
  allowed: true;
} | {
  allowed: false;
  reason: string;
};
//#endregion
//#region src/interfaces/rest/studio.d.ts
declare function serveClaworksStudio(req: IncomingMessage, res: ServerResponse): Promise<boolean>;
//#endregion
//#region src/interfaces/rest/http-utils.d.ts
declare function readJsonBody(req: IncomingMessage): Promise<unknown>;
declare function sendJson(res: ServerResponse, status: number, body: unknown): void;
declare function notFound(res: ServerResponse): void;
declare function badRequest(res: ServerResponse, message: string): void;
declare function parsePath(url: string): string[];
//#endregion
//#region src/interfaces/a2a/types.d.ts
/** Minimal Google A2A subset for ClaWorks robot-to-robot tasks. */
type A2aMessagePart = {
  type: "text";
  text: string;
} | {
  type: "data";
  data: Record<string, unknown>;
};
type A2aMessage = {
  role: "user" | "agent";
  parts: A2aMessagePart[];
};
type A2aTaskStatus = "submitted" | "working" | "completed" | "failed" | "canceled";
type A2aTask = {
  id: string;
  status: A2aTaskStatus;
  createdAt: string;
  updatedAt: string;
  message?: A2aMessage;
  metadata?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: string;
};
type A2aTaskSendRequest = {
  message: A2aMessage;
  metadata?: Record<string, unknown>;
  sessionId?: string;
};
type A2aAgentCard = {
  name: string;
  description: string;
  url: string;
  version: string;
  capabilities: {
    streaming: boolean;
    pushNotifications: boolean;
  };
  defaultInputModes: string[];
  defaultOutputModes: string[];
  skills: Array<{
    id: string;
    name: string;
    description?: string;
  }>;
  endpoints?: {
    tasks: string;
  };
  claworks?: Record<string, unknown>;
};
//#endregion
//#region src/interfaces/a2a/agent-card.d.ts
declare function buildA2aAgentCard(runtime: ClaworksRuntime, baseUrl?: string): A2aAgentCard;
//#endregion
//#region src/interfaces/a2a/client.d.ts
type A2aClientOptions = {
  baseUrl: string;
  fetch?: typeof fetch;
  headers?: Record<string, string>; /** 请求超时（ms，默认 10_000） */
  requestTimeoutMs?: number; /** 强制 HTTPS（生产模式设为 true，拒绝非 HTTPS peer） */
  requireHttps?: boolean;
};
declare class A2aClient {
  private readonly fetchFn;
  private readonly baseUrl;
  private readonly headers;
  private readonly requestTimeoutMs;
  private readonly requireHttps;
  constructor(opts: A2aClientOptions);
  /** AbortSignal-backed timeout wrapper */
  private fetchWithTimeout;
  fetchAgentCard(): Promise<A2aAgentCard>;
  sendTask(req: A2aTaskSendRequest, opts?: {
    idempotencyKey?: string;
  }): Promise<A2aTask>;
  getTask(taskId: string): Promise<A2aTask>;
  sendAndWait(req: A2aTaskSendRequest, opts?: {
    pollMs?: number;
    timeoutMs?: number;
    idempotencyKey?: string;
  }): Promise<A2aTask>;
}
//#endregion
//#region src/interfaces/a2a/task-store.d.ts
type A2aTaskObserver = (task: A2aTask, delta?: {
  type: string;
  data: unknown;
}) => void;
declare class A2aTaskStore {
  private readonly tasks;
  private readonly observers;
  create(req: A2aTaskSendRequest): A2aTask;
  get(taskId: string): A2aTask | undefined;
  update(taskId: string, patch: Partial<Pick<A2aTask, "status" | "result" | "error">>, delta?: {
    type: string;
    data: unknown;
  }): A2aTask | undefined;
  setStatus(taskId: string, status: A2aTaskStatus): A2aTask | undefined;
  /** 推送流式 delta（不修改任务状态，只通知观察者） */
  pushDelta(taskId: string, delta: {
    type: string;
    data: unknown;
  }): void;
  list(limit?: number): A2aTask[];
  /** 订阅指定任务的变更通知，返回取消订阅函数 */
  subscribe(taskId: string, observer: A2aTaskObserver): () => void;
  private _notifyObservers;
}
//#endregion
//#region src/interfaces/a2a/task-handler.d.ts
type A2aHandlerDeps = {
  runtime: ClaworksRuntime;
  store?: A2aTaskStore;
  baseUrl?: string;
};
declare function createA2aHttpHandler(deps: A2aHandlerDeps | (() => ClaworksRuntime | null)): (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;
//#endregion
//#region src/interfaces/mcp/server.d.ts
declare function createMcpHttpHandler(getRuntime: () => ClaworksRuntime | null): (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;
//#endregion
//#region src/interfaces/mcp/tools.d.ts
type McpToolDef = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};
declare const CLAWORKS_MCP_TOOLS: McpToolDef[];
declare function callClaworksMcpTool(runtime: ClaworksRuntime, name: string, args: Record<string, unknown>): Promise<unknown>;
//#endregion
//#region src/interfaces/nexus/catalog.d.ts
type CatalogPackEntry = {
  slug: string;
  dir: string;
  manifest: PackManifest;
};
/** Scan catalog root: each subdir with claworks.pack.json is a pack (version from manifest). */
declare function scanNexusCatalog(catalogRoot: string): Promise<CatalogPackEntry[]>;
declare function extractPackBuffer(buffer: Buffer, destDir: string): Promise<void>;
//#endregion
//#region src/interfaces/nexus/server.d.ts
type NexusServer = {
  catalogRoot: string;
  entries: CatalogPackEntry[];
  refresh(): Promise<void>;
  listen(port: number, host?: string): Promise<ReturnType<typeof createServer>>;
};
declare function createNexusServer(catalogRoot: string): Promise<NexusServer>;
//#endregion
export { serveClaworksStudio as C, resolveAuthContext as D, checkRbac as E, createClaworksRestHandler as O, sendJson as S, checkClaworksApiAuth as T, A2aTaskStatus as _, McpToolDef as a, parsePath as b, createA2aHttpHandler as c, buildA2aAgentCard as d, A2aAgentCard as f, A2aTaskSendRequest as g, A2aTask as h, CLAWORKS_MCP_TOOLS as i, A2aTaskStore as l, A2aMessagePart as m, extractPackBuffer as n, callClaworksMcpTool as o, A2aMessage as p, scanNexusCatalog as r, createMcpHttpHandler as s, createNexusServer as t, A2aClient as u, badRequest as v, AuthContext as w, readJsonBody as x, notFound as y };