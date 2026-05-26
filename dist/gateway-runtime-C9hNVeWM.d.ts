import { N as GatewayAuthConfig, i as OpenClawConfig, nt as GatewayTailscaleConfig, ot as GatewayTrustedProxyConfig, rt as GatewayTailscaleMode } from "./types.openclaw-BLF4DJTX.js";
import { n as GatewayClientName, t as GatewayClientMode } from "./client-info-Bg3dBQ8F.js";
import { a as DeviceIdentity, n as GatewayClientOptions, t as GatewayClient } from "./client-DiDZFgqH.js";
import { Go as OperatorScope } from "./index-CaLNQFzV.js";
import { o as RespondFn, s as NodeSession } from "./types-BMFYBAxt.js";
import { ErrorObject } from "ajv";
import { Command } from "commander";

//#region src/gateway/channel-status-patches.d.ts
type ConnectedChannelStatusPatch = {
  connected: true;
  lastConnectedAt: number;
  lastEventAt: number;
};
type TransportActivityChannelStatusPatch = {
  lastTransportActivityAt: number;
};
declare function createConnectedChannelStatusPatch(at?: number): ConnectedChannelStatusPatch;
declare function createTransportActivityStatusPatch(at?: number): TransportActivityChannelStatusPatch;
//#endregion
//#region src/cli/gateway-rpc.types.d.ts
type GatewayRpcOpts = {
  url?: string;
  token?: string;
  timeout?: string;
  expectFinal?: boolean;
  json?: boolean;
};
//#endregion
//#region src/cli/gateway-rpc.d.ts
declare function addGatewayClientOptions(cmd: Command): Command;
declare function callGatewayFromCli(method: string, opts: GatewayRpcOpts, params?: unknown, extra?: {
  clientName?: GatewayClientName;
  mode?: GatewayClientMode;
  deviceIdentity?: DeviceIdentity | null;
  expectFinal?: boolean;
  progress?: boolean;
  scopes?: OperatorScope[];
}): Promise<Record<string, unknown>>;
//#endregion
//#region src/gateway/hosted-plugin-surface-url.d.ts
type HostSource = string | null | undefined;
type HostedPluginSurfaceUrlParams = {
  port?: number;
  hostOverride?: HostSource;
  forwardedHost?: HostSource | HostSource[];
  requestHost?: HostSource;
  forwardedProto?: HostSource | HostSource[];
  localAddress?: HostSource;
  scheme?: "http" | "https";
};
declare function resolveHostedPluginSurfaceUrl(params: HostedPluginSurfaceUrlParams): string | undefined;
//#endregion
//#region src/gateway/node-command-policy.d.ts
type NodeCommandPolicyNode = Pick<NodeSession, "platform" | "deviceFamily"> & Partial<Pick<NodeSession, "caps" | "commands" | "connId" | "nodeId">> & {
  approvedCommands?: readonly string[];
};
declare function resolveNodeCommandAllowlist(cfg: OpenClawConfig, node?: NodeCommandPolicyNode): Set<string>;
declare function isNodeCommandAllowed(params: {
  command: string;
  declaredCommands?: string[];
  allowlist: Set<string>;
}): {
  ok: true;
} | {
  ok: false;
  reason: string;
};
//#endregion
//#region src/shared/node-match.d.ts
type NodeMatchCandidate = {
  nodeId: string;
  displayName?: string;
  remoteIp?: string;
  connected?: boolean;
  clientId?: string;
};
//#endregion
//#region src/shared/node-resolve.d.ts
type ResolveNodeFromListOptions<TNode extends NodeMatchCandidate> = {
  allowDefault?: boolean;
  pickDefaultNode?: (nodes: TNode[]) => TNode | null;
};
declare function resolveNodeIdFromNodeList<TNode extends NodeMatchCandidate>(nodes: TNode[], query?: string, options?: ResolveNodeFromListOptions<TNode>): string;
declare function resolveNodeFromNodeList<TNode extends NodeMatchCandidate>(nodes: TNode[], query?: string, options?: ResolveNodeFromListOptions<TNode>): TNode;
//#endregion
//#region src/gateway/server-json.d.ts
declare function safeParseJson(value: string | null | undefined): unknown;
//#endregion
//#region src/gateway/server-methods/nodes.helpers.d.ts
declare function respondUnavailableOnNodeInvokeError<T extends {
  ok: boolean;
  error?: unknown;
}>(respond: RespondFn, res: T): res is T & {
  ok: true;
};
//#endregion
//#region src/gateway/auth-resolve.d.ts
type ResolvedGatewayAuthMode = "none" | "token" | "password" | "trusted-proxy";
type ResolvedGatewayAuthModeSource = "override" | "config" | "password" | "token" | "default";
type ResolvedGatewayAuth = {
  mode: ResolvedGatewayAuthMode;
  modeSource?: ResolvedGatewayAuthModeSource;
  token?: string;
  password?: string;
  allowTailscale: boolean;
  trustedProxy?: GatewayTrustedProxyConfig;
};
declare function resolveGatewayAuth(params: {
  authConfig?: GatewayAuthConfig | null;
  authOverride?: GatewayAuthConfig | null;
  env?: NodeJS.ProcessEnv;
  tailscaleMode?: GatewayTailscaleMode;
}): ResolvedGatewayAuth;
//#endregion
//#region src/gateway/startup-auth.d.ts
declare function ensureGatewayStartupAuth(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  authOverride?: GatewayAuthConfig;
  tailscaleOverride?: GatewayTailscaleConfig;
  /**
   * Legacy startup option retained for external callers. Startup-generated auth
   * is runtime-only; durable auth changes must go through explicit config tools.
   */
  persist?: boolean;
  baseHash?: string;
}): Promise<{
  cfg: OpenClawConfig;
  auth: ReturnType<typeof resolveGatewayAuth>;
  generatedToken?: string;
  persistedGeneratedToken: boolean;
}>;
//#endregion
//#region src/gateway/event-loop-ready.d.ts
type EventLoopReadyResult = {
  ready: boolean;
  elapsedMs: number;
  maxDriftMs: number;
  checks: number;
  aborted: boolean;
};
//#endregion
//#region src/gateway/client-start-readiness.d.ts
type GatewayClientStartReadinessOptions = {
  timeoutMs?: number;
  clientOptions?: Pick<GatewayClientOptions, "connectChallengeTimeoutMs" | "connectDelayMs" | "preauthHandshakeTimeoutMs">;
  signal?: AbortSignal;
};
declare function startGatewayClientWhenEventLoopReady(client: GatewayClient, options?: GatewayClientStartReadinessOptions): Promise<EventLoopReadyResult>;
//#endregion
//#region src/gateway/operator-approvals-client.d.ts
declare function createOperatorApprovalsGatewayClient(params: Pick<GatewayClientOptions, "clientDisplayName" | "onClose" | "onConnectError" | "onEvent" | "onHelloOk" | "onReconnectPaused"> & {
  config: OpenClawConfig;
  gatewayUrl?: string;
}): Promise<GatewayClient>;
declare function withOperatorApprovalsGatewayClient<T>(params: {
  config: OpenClawConfig;
  gatewayUrl?: string;
  clientDisplayName: string;
}, run: (client: GatewayClient) => Promise<T>): Promise<T>;
//#endregion
export { GatewayRpcOpts as _, resolveGatewayAuth as a, createConnectedChannelStatusPatch as b, resolveNodeFromNodeList as c, isNodeCommandAllowed as d, resolveNodeCommandAllowlist as f, callGatewayFromCli as g, addGatewayClientOptions as h, ensureGatewayStartupAuth as i, resolveNodeIdFromNodeList as l, resolveHostedPluginSurfaceUrl as m, withOperatorApprovalsGatewayClient as n, respondUnavailableOnNodeInvokeError as o, HostedPluginSurfaceUrlParams as p, startGatewayClientWhenEventLoopReady as r, safeParseJson as s, createOperatorApprovalsGatewayClient as t, NodeMatchCandidate as u, ConnectedChannelStatusPatch as v, createTransportActivityStatusPatch as x, TransportActivityChannelStatusPatch as y };