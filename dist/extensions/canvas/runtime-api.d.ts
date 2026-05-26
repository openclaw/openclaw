import { i as OpenClawConfig } from "../../types.openclaw-BLF4DJTX.js";
import { n as RuntimeEnv } from "../../runtime-Bxifh4bY.js";
import { l as NormalizedPluginNodeCapabilityUrl } from "../../types-BMFYBAxt.js";
import { p as HostedPluginSurfaceUrlParams } from "../../gateway-runtime-C9hNVeWM.js";
import { Duplex } from "node:stream";
import { WebSocketServer } from "ws";
import { IncomingMessage, ServerResponse } from "node:http";
import chokidar from "chokidar";
import { Command } from "commander";

//#region extensions/canvas/src/config.d.ts
type CanvasHostConfig = {
  enabled?: boolean;
  root?: string;
  port?: number;
  liveReload?: boolean;
};
type CanvasPluginConfig = {
  host?: CanvasHostConfig;
};
type CanvasPluginConfigSchema = {
  parse: (value: unknown) => CanvasPluginConfig;
  uiHints: Record<string, {
    label: string;
    help?: string;
    advanced?: boolean;
  }>;
};
declare function parseCanvasPluginConfig(value: unknown): CanvasPluginConfig;
declare function isCanvasPluginEnabled(config?: OpenClawConfig): boolean;
declare function resolveCanvasHostConfig(params: {
  config?: OpenClawConfig;
  pluginConfig?: Record<string, unknown>;
}): CanvasHostConfig;
declare function isCanvasHostEnabled(config?: OpenClawConfig): boolean;
declare const canvasConfigSchema: CanvasPluginConfigSchema;
//#endregion
//#region extensions/canvas/src/host/a2ui-shared.d.ts
declare const A2UI_PATH = "/__openclaw__/a2ui";
declare const CANVAS_HOST_PATH = "/__openclaw__/canvas";
declare const CANVAS_WS_PATH = "/__openclaw__/ws";
//#endregion
//#region extensions/canvas/src/host/a2ui.d.ts
declare function handleA2uiHttpRequest(req: IncomingMessage, res: ServerResponse): Promise<boolean>;
//#endregion
//#region extensions/canvas/src/host/server.d.ts
type CanvasHostOpts = {
  runtime: RuntimeEnv;
  rootDir?: string;
  port?: number;
  listenHost?: string;
  allowInTests?: boolean;
  liveReload?: boolean;
  watchFactory?: typeof chokidar.watch;
  webSocketServerClass?: typeof WebSocketServer;
};
type CanvasHostServerOpts = CanvasHostOpts & {
  handler?: CanvasHostHandler;
  ownsHandler?: boolean;
};
type CanvasHostServer = {
  port: number;
  rootDir: string;
  close: () => Promise<void>;
};
type CanvasHostHandlerOpts = {
  runtime: RuntimeEnv;
  rootDir?: string;
  basePath?: string;
  allowInTests?: boolean;
  liveReload?: boolean;
  watchFactory?: typeof chokidar.watch;
  webSocketServerClass?: typeof WebSocketServer;
};
type CanvasHostHandler = {
  rootDir: string;
  basePath: string;
  handleHttpRequest: (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;
  handleUpgrade: (req: IncomingMessage, socket: Duplex, head: Buffer) => boolean;
  close: () => Promise<void>;
};
declare function createCanvasHostHandler(opts: CanvasHostHandlerOpts): Promise<CanvasHostHandler>;
declare function startCanvasHost(opts: CanvasHostServerOpts): Promise<CanvasHostServer>;
//#endregion
//#region extensions/canvas/src/documents.d.ts
type CanvasDocumentKind = "html_bundle" | "url_embed" | "document" | "image" | "video_asset";
type CanvasDocumentAsset = {
  logicalPath: string;
  sourcePath: string;
  contentType?: string;
};
type CanvasDocumentEntrypoint = {
  type: "html";
  value: string;
} | {
  type: "path";
  value: string;
} | {
  type: "url";
  value: string;
};
type CanvasDocumentCreateInput = {
  id?: string;
  kind: CanvasDocumentKind;
  title?: string;
  preferredHeight?: number;
  entrypoint?: CanvasDocumentEntrypoint;
  assets?: CanvasDocumentAsset[];
  surface?: "assistant_message" | "tool_card" | "sidebar";
};
type CanvasDocumentManifest = {
  id: string;
  kind: CanvasDocumentKind;
  title?: string;
  preferredHeight?: number;
  createdAt: string;
  entryUrl: string;
  localEntrypoint?: string;
  externalUrl?: string;
  surface?: "assistant_message" | "tool_card" | "sidebar";
  assets: Array<{
    logicalPath: string;
    contentType?: string;
  }>;
};
type CanvasDocumentResolvedAsset = {
  logicalPath: string;
  contentType?: string;
  url: string;
  localPath: string;
};
declare function resolveCanvasDocumentDir(documentId: string, options?: {
  rootDir?: string;
  stateDir?: string;
}): string;
declare function buildCanvasDocumentEntryUrl(documentId: string, entrypoint: string): string;
declare function resolveCanvasHttpPathToLocalPath(requestPath: string, options?: {
  rootDir?: string;
  stateDir?: string;
}): string | null;
declare function createCanvasDocument(input: CanvasDocumentCreateInput, options?: {
  stateDir?: string;
  workspaceDir?: string;
  canvasRootDir?: string;
}): Promise<CanvasDocumentManifest>;
declare function resolveCanvasDocumentAssets(manifest: CanvasDocumentManifest, options?: {
  baseUrl?: string;
  stateDir?: string;
  canvasRootDir?: string;
}): CanvasDocumentResolvedAsset[];
//#endregion
//#region extensions/canvas/src/cli.d.ts
type CanvasCliRuntime = {
  log: (message: string) => void;
  error: (message: string) => void;
  exit: (code: number) => void;
  writeJson: (value: unknown) => void;
};
type CanvasNodesRpcOpts = {
  url?: string;
  token?: string;
  timeout?: string;
  json?: boolean;
  node?: string;
  invokeTimeout?: string;
  target?: string;
  x?: string;
  y?: string;
  width?: string;
  height?: string;
  js?: string;
  jsonl?: string;
  text?: string;
  format?: string;
  maxWidth?: string;
  quality?: string;
};
type CanvasCliDependencies = {
  defaultRuntime: CanvasCliRuntime;
  nodesCallOpts: (cmd: Command, defaults?: {
    timeoutMs?: number;
  }) => Command;
  runNodesCommand: (label: string, action: () => Promise<void>) => Promise<void> | void;
  getNodesTheme: () => {
    ok: (value: string) => string;
  };
  parseTimeoutMs: (raw: unknown) => number | undefined;
  resolveNodeId: (opts: CanvasNodesRpcOpts, query: string) => Promise<string>;
  buildNodeInvokeParams: (params: {
    nodeId: string;
    command: string;
    params?: Record<string, unknown>;
    timeoutMs?: number;
  }) => Record<string, unknown>;
  callGatewayCli: (method: string, opts: CanvasNodesRpcOpts, params?: unknown, callOpts?: {
    transportTimeoutMs?: number;
  }) => Promise<unknown>;
  writeBase64ToFile: (filePath: string, base64: string) => Promise<unknown>;
  shortenHomePath: (filePath: string) => string;
};
declare function registerNodesCanvasCommands(nodes: Command, deps: CanvasCliDependencies): void;
//#endregion
//#region extensions/canvas/src/cli-helpers.d.ts
type CanvasSnapshotPayload = {
  format: CanvasSnapshotFormat;
  base64: string;
};
type CanvasSnapshotFormat = "png" | "jpg" | "jpeg";
declare function parseCanvasSnapshotPayload(value: unknown): CanvasSnapshotPayload;
declare function canvasSnapshotTempPath(opts: {
  ext: string;
  tmpDir?: string;
  id?: string;
}): string;
//#endregion
//#region extensions/canvas/src/capability.d.ts
declare const CANVAS_CAPABILITY_PATH_PREFIX = "/__openclaw__/cap";
declare const CANVAS_CAPABILITY_TTL_MS: number;
type NormalizedCanvasScopedUrl = NormalizedPluginNodeCapabilityUrl;
declare function mintCanvasCapabilityToken(): string;
declare function buildCanvasScopedHostUrl(baseUrl: string, capability: string): string | undefined;
declare function normalizeCanvasScopedUrl(rawUrl: string): NormalizedCanvasScopedUrl;
//#endregion
//#region extensions/canvas/src/host-url.d.ts
type CanvasHostUrlParams = Omit<HostedPluginSurfaceUrlParams, "port"> & {
  canvasPort?: number;
};
declare function resolveCanvasHostUrl(params: CanvasHostUrlParams): string | undefined;
//#endregion
export { A2UI_PATH, CANVAS_CAPABILITY_PATH_PREFIX, CANVAS_CAPABILITY_TTL_MS, CANVAS_HOST_PATH, CANVAS_WS_PATH, type CanvasCliDependencies, type CanvasHostConfig, type CanvasHostHandler, type CanvasHostServer, type CanvasNodesRpcOpts, type CanvasPluginConfig, buildCanvasDocumentEntryUrl, buildCanvasScopedHostUrl, canvasConfigSchema, canvasSnapshotTempPath, createCanvasDocument, createCanvasHostHandler, handleA2uiHttpRequest, isCanvasHostEnabled, isCanvasPluginEnabled, mintCanvasCapabilityToken, normalizeCanvasScopedUrl, parseCanvasPluginConfig, parseCanvasSnapshotPayload, registerNodesCanvasCommands, resolveCanvasDocumentAssets, resolveCanvasDocumentDir, resolveCanvasHostConfig, resolveCanvasHostUrl, resolveCanvasHttpPathToLocalPath, startCanvasHost };