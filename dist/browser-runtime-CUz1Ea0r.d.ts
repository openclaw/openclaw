import { r as ResolvedBrowserProfile } from "./config-Bwfo-mwZ.js";
import { a as BrowserRouteContext, c as BrowserTab, l as BrowserTransport, o as BrowserServerState, s as BrowserStatus, u as SnapshotAriaNode } from "./bridge-server-BZG1jM-5.js";
import { Server } from "node:http";
import { Express, Request } from "express";
//#region extensions/browser/src/browser/client-actions-types.d.ts
type BrowserActionOk = {
  ok: true;
};
type BrowserActionTabResult = {
  ok: true;
  targetId: string;
  url?: string;
};
type BrowserActionPathResult = {
  ok: true;
  path: string;
  targetId: string;
  url?: string;
  labels?: boolean;
  labelsCount?: number;
  labelsSkipped?: number;
};
//#endregion
//#region extensions/browser/src/browser/client-actions.types.d.ts
type BrowserFormField = {
  ref: string;
  type: string;
  value?: string | number | boolean;
};
type BrowserActRequest = {
  kind: "click";
  ref?: string;
  selector?: string;
  targetId?: string;
  doubleClick?: boolean;
  button?: string;
  modifiers?: string[];
  delayMs?: number;
  timeoutMs?: number;
} | {
  kind: "clickCoords";
  x: number;
  y: number;
  targetId?: string;
  doubleClick?: boolean;
  button?: string;
  delayMs?: number;
  timeoutMs?: number;
} | {
  kind: "type";
  ref?: string;
  selector?: string;
  text: string;
  targetId?: string;
  submit?: boolean;
  slowly?: boolean;
  timeoutMs?: number;
} | {
  kind: "press";
  key: string;
  targetId?: string;
  delayMs?: number;
} | {
  kind: "hover";
  ref?: string;
  selector?: string;
  targetId?: string;
  timeoutMs?: number;
} | {
  kind: "scrollIntoView";
  ref?: string;
  selector?: string;
  targetId?: string;
  timeoutMs?: number;
} | {
  kind: "drag";
  startRef?: string;
  startSelector?: string;
  endRef?: string;
  endSelector?: string;
  targetId?: string;
  timeoutMs?: number;
} | {
  kind: "select";
  ref?: string;
  selector?: string;
  values: string[];
  targetId?: string;
  timeoutMs?: number;
} | {
  kind: "fill";
  fields: BrowserFormField[];
  targetId?: string;
  timeoutMs?: number;
} | {
  kind: "resize";
  width: number;
  height: number;
  targetId?: string;
} | {
  kind: "wait";
  timeMs?: number;
  text?: string;
  textGone?: string;
  selector?: string;
  url?: string;
  loadState?: "load" | "domcontentloaded" | "networkidle";
  fn?: string;
  targetId?: string;
  timeoutMs?: number;
} | {
  kind: "evaluate";
  fn: string;
  ref?: string;
  targetId?: string;
  timeoutMs?: number;
} | {
  kind: "close";
  targetId?: string;
} | {
  kind: "batch";
  actions: BrowserActRequest[];
  targetId?: string;
  stopOnError?: boolean;
};
//#endregion
//#region extensions/browser/src/browser/client-actions-core.d.ts
type BrowserActResponse = {
  ok: true;
  targetId: string;
  url?: string;
  result?: unknown;
  results?: Array<{
    ok: boolean;
    error?: string;
  }>;
  blockedByDialog?: boolean;
  browserState?: unknown;
};
declare function browserNavigate(baseUrl: string | undefined, opts: {
  url: string;
  targetId?: string;
  profile?: string;
}): Promise<BrowserActionTabResult>;
declare function browserArmDialog(baseUrl: string | undefined, opts: {
  accept: boolean;
  promptText?: string;
  dialogId?: string;
  targetId?: string;
  timeoutMs?: number;
  profile?: string;
}): Promise<BrowserActionOk>;
declare function browserArmFileChooser(baseUrl: string | undefined, opts: {
  paths: string[];
  ref?: string;
  inputRef?: string;
  element?: string;
  targetId?: string;
  timeoutMs?: number;
  profile?: string;
}): Promise<BrowserActionOk>;
declare function browserAct(baseUrl: string | undefined, req: BrowserActRequest, opts?: {
  profile?: string;
  timeoutMs?: number;
}): Promise<BrowserActResponse>;
declare function browserScreenshotAction(baseUrl: string | undefined, opts: {
  targetId?: string;
  fullPage?: boolean;
  ref?: string;
  element?: string;
  type?: "png" | "jpeg";
  labels?: boolean;
  timeoutMs?: number;
  profile?: string;
}): Promise<BrowserActionPathResult>;
//#endregion
//#region extensions/browser/src/browser/pw-session.d.ts
type BrowserConsoleMessage = {
  type: string;
  text: string;
  timestamp: string;
  location?: {
    url?: string;
    lineNumber?: number;
    columnNumber?: number;
  };
};
//#endregion
//#region extensions/browser/src/browser/client-actions-observe.d.ts
declare function browserConsoleMessages(baseUrl: string | undefined, opts?: {
  level?: string;
  targetId?: string;
  profile?: string;
}): Promise<{
  ok: true;
  messages: BrowserConsoleMessage[];
  targetId: string;
  url?: string;
}>;
declare function browserPdfSave(baseUrl: string | undefined, opts?: {
  targetId?: string;
  profile?: string;
}): Promise<BrowserActionPathResult>;
//#endregion
//#region extensions/browser/src/browser/doctor.d.ts
type BrowserDoctorCheckStatus = "pass" | "warn" | "fail" | "info";
type BrowserDoctorCheck = {
  id: string;
  label: string;
  status: BrowserDoctorCheckStatus;
  summary: string;
  fixHint?: string;
};
type BrowserDoctorReport = {
  ok: boolean;
  profile: string;
  transport: BrowserTransport;
  checks: BrowserDoctorCheck[];
  status: BrowserStatus;
};
//#endregion
//#region extensions/browser/src/browser/client.d.ts
type ProfileStatus = {
  name: string;
  transport?: BrowserTransport;
  cdpPort: number | null;
  cdpUrl: string | null;
  color: string;
  driver: "openclaw" | "existing-session";
  running: boolean;
  tabCount: number;
  isDefault: boolean;
  isRemote: boolean;
  missingFromConfig?: boolean;
  reconcileReason?: string | null;
};
type BrowserResetProfileResult = {
  ok: true;
  moved: boolean;
  from: string;
  to?: string;
};
type SnapshotResult = {
  ok: true;
  format: "aria";
  targetId: string;
  url: string;
  nodes: SnapshotAriaNode[];
  blockedByDialog?: boolean;
  browserState?: unknown;
} | {
  ok: true;
  format: "ai";
  targetId: string;
  url: string;
  snapshot: string;
  truncated?: boolean;
  refs?: Record<string, {
    role: string;
    name?: string;
    nth?: number;
  }>;
  stats?: {
    lines: number;
    chars: number;
    refs: number;
    interactive: number;
  };
  labels?: boolean;
  labelsCount?: number;
  labelsSkipped?: number;
  imagePath?: string;
  imageType?: "png" | "jpeg";
  blockedByDialog?: boolean;
  browserState?: unknown;
};
declare function browserStatus(baseUrl?: string, opts?: {
  profile?: string;
  timeoutMs?: number;
}): Promise<BrowserStatus>;
declare function browserDoctor(baseUrl?: string, opts?: {
  profile?: string;
  deep?: boolean;
}): Promise<BrowserDoctorReport>;
declare function browserProfiles(baseUrl?: string, opts?: {
  timeoutMs?: number;
}): Promise<ProfileStatus[]>;
declare function browserStart(baseUrl?: string, opts?: {
  profile?: string;
  timeoutMs?: number;
}): Promise<void>;
declare function browserStop(baseUrl?: string, opts?: {
  profile?: string;
  timeoutMs?: number;
}): Promise<void>;
declare function browserResetProfile(baseUrl?: string, opts?: {
  profile?: string;
}): Promise<BrowserResetProfileResult>;
type BrowserCreateProfileResult = {
  ok: true;
  profile: string;
  transport?: BrowserTransport;
  cdpPort: number | null;
  cdpUrl: string | null;
  userDataDir: string | null;
  color: string;
  isRemote: boolean;
};
declare function browserCreateProfile(baseUrl: string | undefined, opts: {
  name: string;
  color?: string;
  cdpUrl?: string;
  userDataDir?: string;
  driver?: "openclaw" | "existing-session";
}): Promise<BrowserCreateProfileResult>;
type BrowserDeleteProfileResult = {
  ok: true;
  profile: string;
  deleted: boolean;
};
declare function browserDeleteProfile(baseUrl: string | undefined, profile: string): Promise<BrowserDeleteProfileResult>;
declare function browserTabs(baseUrl?: string, opts?: {
  profile?: string;
  timeoutMs?: number;
}): Promise<BrowserTab[]>;
declare function browserOpenTab(baseUrl: string | undefined, url: string, opts?: {
  profile?: string;
  label?: string;
  timeoutMs?: number;
}): Promise<BrowserTab>;
declare function browserFocusTab(baseUrl: string | undefined, targetId: string, opts?: {
  profile?: string;
  timeoutMs?: number;
}): Promise<void>;
declare function browserCloseTab(baseUrl: string | undefined, targetId: string, opts?: {
  profile?: string;
  timeoutMs?: number;
}): Promise<void>;
declare function browserTabAction(baseUrl: string | undefined, opts: {
  action: "list" | "new" | "close" | "select";
  index?: number;
  profile?: string;
}): Promise<unknown>;
declare function browserSnapshot(baseUrl: string | undefined, opts: {
  format?: "aria" | "ai";
  targetId?: string;
  limit?: number;
  maxChars?: number;
  refs?: "role" | "aria";
  interactive?: boolean;
  compact?: boolean;
  depth?: number;
  selector?: string;
  frame?: string;
  labels?: boolean;
  urls?: boolean;
  mode?: "efficient";
  profile?: string;
}): Promise<SnapshotResult>;
//#endregion
//#region extensions/browser/src/node-host/invoke-browser.d.ts
declare function runBrowserProxyCommand(paramsJSON?: string | null): Promise<string>;
//#endregion
//#region extensions/browser/src/browser/profile-capabilities.d.ts
type BrowserProfileMode = "local-managed" | "local-existing-session" | "remote-cdp";
type BrowserProfileCapabilities = {
  mode: BrowserProfileMode;
  isRemote: boolean; /** Profile uses the Chrome DevTools MCP server (existing-session driver). */
  usesChromeMcp: boolean;
  usesPersistentPlaywright: boolean;
  supportsPerTabWs: boolean;
  supportsJsonTabEndpoints: boolean;
  supportsReset: boolean;
  supportsManagedTabLimit: boolean;
};
declare function getBrowserProfileCapabilities(profile: ResolvedBrowserProfile): BrowserProfileCapabilities;
//#endregion
//#region extensions/browser/src/browser/proxy-files.d.ts
type BrowserProxyFile = {
  path: string;
  base64: string;
  mimeType?: string;
};
declare function persistBrowserProxyFiles(files: BrowserProxyFile[] | undefined): Promise<Map<string, string>>;
declare function applyBrowserProxyPaths(result: unknown, mapping: Map<string, string>): void;
//#endregion
//#region extensions/browser/src/browser/request-policy.d.ts
type BrowserRequestProfileParams = {
  query?: Record<string, unknown>;
  body?: unknown;
  profile?: string | null;
};
declare function normalizeBrowserRequestPath(value: string): string;
declare function isPersistentBrowserProfileMutation(method: string, path: string): boolean;
declare function resolveRequestedBrowserProfile(params: BrowserRequestProfileParams): string | undefined;
//#endregion
//#region extensions/browser/src/browser-control-state.d.ts
declare function getBrowserControlState(): BrowserServerState | null;
declare function createBrowserControlContext(): BrowserRouteContext;
//#endregion
//#region extensions/browser/src/control-service.d.ts
declare function startBrowserControlServiceFromConfig(): Promise<BrowserServerState | null>;
declare function stopBrowserControlService(): Promise<void>;
//#endregion
//#region extensions/browser/src/browser/runtime-lifecycle.d.ts
declare function createBrowserRuntimeState(params: {
  resolved: BrowserServerState["resolved"];
  port: number;
  server?: Server | null;
  onWarn: (message: string) => void;
}): Promise<BrowserServerState>;
declare function stopBrowserRuntime(params: {
  current: BrowserServerState | null;
  getState: () => BrowserServerState | null;
  clearState: () => void;
  closeServer?: boolean;
  onWarn: (message: string) => void;
}): Promise<void>;
//#endregion
//#region extensions/browser/src/browser/routes/types.d.ts
type BrowserRequest = {
  params: Record<string, string>;
  query: Record<string, unknown>;
  body?: unknown;
  /**
   * Optional abort signal for in-process dispatch. This lets callers enforce
   * timeouts and (where supported) cancel long-running operations.
   */
  signal?: AbortSignal;
};
type BrowserResponse = {
  status: (code: number) => BrowserResponse;
  json: (body: unknown) => void;
};
type BrowserRouteHandler = (req: BrowserRequest, res: BrowserResponse) => void | Promise<void>;
type BrowserRouteRegistrar = {
  get: (path: string, handler: BrowserRouteHandler) => void;
  post: (path: string, handler: BrowserRouteHandler) => void;
  delete: (path: string, handler: BrowserRouteHandler) => void;
};
//#endregion
//#region extensions/browser/src/browser/routes/index.d.ts
declare function registerBrowserRoutes(app: BrowserRouteRegistrar, ctx: BrowserRouteContext): void;
//#endregion
//#region extensions/browser/src/browser/routes/dispatcher.d.ts
type BrowserDispatchRequest = {
  method: "GET" | "POST" | "DELETE";
  path: string;
  query?: Record<string, unknown>;
  body?: unknown;
  signal?: AbortSignal;
};
type BrowserDispatchResponse = {
  status: number;
  body: unknown;
};
declare function createBrowserRouteDispatcher(ctx: BrowserRouteContext): {
  dispatch: (req: BrowserDispatchRequest) => Promise<BrowserDispatchResponse>;
};
//#endregion
//#region extensions/browser/src/browser/server-middleware.d.ts
declare function installBrowserCommonMiddleware(app: Express): void;
declare function installBrowserAuthMiddleware(app: Express, auth: {
  token?: string;
  password?: string;
}): void;
//#endregion
//#region extensions/browser/src/browser/form-fields.d.ts
type BrowserFormFieldValue = NonNullable<BrowserFormField["value"]>;
declare function normalizeBrowserFormFieldValue(value: unknown): BrowserFormFieldValue | undefined;
declare function normalizeBrowserFormField(record: Record<string, unknown>): BrowserFormField | null;
//#endregion
export { browserFocusTab as A, BrowserDoctorCheck as B, BrowserResetProfileResult as C, browserCreateProfile as D, browserCloseTab as E, browserStart as F, browserArmDialog as G, browserConsoleMessages as H, browserStatus as I, browserScreenshotAction as J, browserArmFileChooser as K, browserStop as L, browserProfiles as M, browserResetProfile as N, browserDeleteProfile as O, browserSnapshot as P, browserTabAction as R, BrowserDeleteProfileResult as S, SnapshotResult as T, browserPdfSave as U, BrowserDoctorReport as V, browserAct as W, BrowserFormField as Y, applyBrowserProxyPaths as _, createBrowserRouteDispatcher as a, runBrowserProxyCommand as b, createBrowserRuntimeState as c, stopBrowserControlService as d, createBrowserControlContext as f, resolveRequestedBrowserProfile as g, normalizeBrowserRequestPath as h, installBrowserCommonMiddleware as i, browserOpenTab as j, browserDoctor as k, stopBrowserRuntime as l, isPersistentBrowserProfileMutation as m, normalizeBrowserFormFieldValue as n, registerBrowserRoutes as o, getBrowserControlState as p, browserNavigate as q, installBrowserAuthMiddleware as r, BrowserRouteRegistrar as s, normalizeBrowserFormField as t, startBrowserControlServiceFromConfig as u, persistBrowserProxyFiles as v, ProfileStatus as w, BrowserCreateProfileResult as x, getBrowserProfileCapabilities as y, browserTabs as z };