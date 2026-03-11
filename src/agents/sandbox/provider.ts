/**
 * ISandboxProvider — pluggable sandbox backend contract.
 *
 * All sandbox backends (Docker, gVisor, Firecracker) implement this interface.
 * provider.ts defines abstract types ONLY — no imports from docker.ts or manage.ts
 * to avoid circular dependencies.
 */

export type SandboxBackend = "auto" | "docker" | "gvisor" | "firecracker";

export interface ProviderHealthResult {
  available: boolean;
  message: string;
  version?: string;
}

export interface ExecResult {
  stdout: Buffer;
  stderr: Buffer;
  code: number;
}

export interface SandboxState {
  exists: boolean;
  running: boolean;
}

export interface EnsureSandboxParams {
  sessionKey: string;
  workspaceDir: string;
  agentWorkspaceDir: string;
  cfg: import("./types.js").SandboxConfig;
}

export interface ExecOptions {
  timeout?: number;
  cwd?: string;
  env?: Record<string, string>;
  allowFailure?: boolean;
}

export interface DestroyOptions {
  force?: boolean;
}

export interface SandboxInfo {
  containerName: string;
  sessionKey?: string;
  running: boolean;
  image?: string;
}

export interface ISandboxProvider {
  readonly name: Exclude<SandboxBackend, "auto">;
  checkHealth(): Promise<ProviderHealthResult>;
  ensureSandbox(params: EnsureSandboxParams): Promise<string>;
  exec(containerName: string, args: string[], opts?: ExecOptions): Promise<ExecResult>;
  destroy(containerName: string, opts?: DestroyOptions): Promise<void>;
  status(containerName: string): Promise<SandboxState>;
  list(): Promise<SandboxInfo[]>;
}

// --- Browser Automation (optional capability) ---

export interface BrowserSessionResult {
  sessionId: string;
}

export interface BrowserScreenshotResult {
  data: Buffer;
}

export interface BrowserPageInfo {
  title: string;
  url: string;
}

/**
 * IBrowserCapable -- optional interface for providers that support browser automation.
 * Does NOT extend ISandboxProvider to avoid breaking non-browser providers.
 * Use isBrowserCapable() type guard for runtime detection.
 */
export interface IBrowserCapable {
  launchBrowser(
    sandboxId: string,
    config?: import("./types.js").SandboxBrowserConfig,
  ): Promise<BrowserSessionResult>;
  navigateBrowser(
    sandboxId: string,
    sessionId: string,
    url: string,
    timeoutMs?: number,
  ): Promise<{ url: string; title: string }>;
  clickBrowser(sandboxId: string, sessionId: string, selector: string): Promise<void>;
  typeBrowser(sandboxId: string, sessionId: string, selector: string, text: string): Promise<void>;
  screenshotBrowser(
    sandboxId: string,
    sessionId: string,
    opts?: { fullPage?: boolean; quality?: number },
  ): Promise<BrowserScreenshotResult>;
  evaluateJS(sandboxId: string, sessionId: string, expression: string): Promise<string>;
  extractContent(
    sandboxId: string,
    sessionId: string,
    selector: string,
  ): Promise<{ text: string; html: string }>;
  waitForSelector(
    sandboxId: string,
    sessionId: string,
    selector: string,
    timeoutMs?: number,
  ): Promise<boolean>;
  getPageInfo(sandboxId: string, sessionId: string): Promise<BrowserPageInfo>;
  closeBrowser(sandboxId: string, sessionId: string): Promise<void>;
}

/**
 * Type guard: checks if a provider supports browser automation via duck-typing.
 */
export function isBrowserCapable(
  provider: ISandboxProvider,
): provider is ISandboxProvider & IBrowserCapable {
  return "launchBrowser" in provider;
}
