import { ExecBrowserHelper } from "../browser/exec-browser.js";
import { execDockerRaw, execDocker, dockerContainerState } from "../docker.js";
import {
  syncToSandbox as fsSyncToSandbox,
  syncFromSandbox as fsSyncFromSandbox,
} from "../hardening/filesystem.js";
import { DEFAULT_NETWORK_MODE, buildNetworkFlag } from "../hardening/network-isolation.js";
import { DEFAULT_RESOURCE_LIMITS, buildResourceLimitFlags } from "../hardening/resource-limits.js";
import { filterSecretsFromEnv } from "../hardening/secret-filter.js";
import { listSandboxContainers } from "../manage.js";
import type {
  ISandboxProvider,
  IBrowserCapable,
  ProviderHealthResult,
  ExecResult,
  BrowserSessionResult,
  BrowserScreenshotResult,
  BrowserPageInfo,
  SandboxState,
  EnsureSandboxParams,
  ExecOptions,
  DestroyOptions,
  SandboxInfo,
} from "../provider.js";
import type { SandboxBrowserConfig } from "../types.js";

/**
 * DockerProvider — Docker sandbox backend with hardening integration.
 *
 * ensureSandbox() creates containers with resource limits, network isolation,
 * and secret-filtered environment variables. Other methods delegate directly
 * to existing Docker functions.
 */
export class DockerProvider implements ISandboxProvider, IBrowserCapable {
  readonly name = "docker" as const;
  private browserHelper: ExecBrowserHelper | null = null;

  private getBrowserHelper(): ExecBrowserHelper {
    if (!this.browserHelper) {
      this.browserHelper = new ExecBrowserHelper((containerName, args, opts) =>
        this.exec(containerName, args, opts),
      );
    }
    return this.browserHelper;
  }

  async checkHealth(): Promise<ProviderHealthResult> {
    try {
      const result = await execDocker(["info", "--format", "{{.ServerVersion}}"], {
        allowFailure: true,
      });
      if (result.code === 0) {
        const version = result.stdout.trim();
        return {
          available: true,
          message: "Docker daemon is running",
          version: `Docker ${version}`,
        };
      }
      return {
        available: false,
        message: `Docker info failed with exit code ${result.code}: ${result.stderr.trim()}`,
      };
    } catch (err) {
      return {
        available: false,
        message: `Docker health check error: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  async ensureSandbox(params: EnsureSandboxParams): Promise<string> {
    const containerName = `openclaw-sandbox-${params.sessionKey}`;

    // Check if container already exists and is running
    const state = await dockerContainerState(containerName);
    if (state.exists && state.running) {
      return containerName;
    }

    // Build Docker create args with hardening flags
    const createArgs: string[] = ["create", "--name", containerName];

    // Resource limits (custom or defaults)
    const resourceFlags = buildResourceLimitFlags(
      params.cfg.resourceLimits ?? DEFAULT_RESOURCE_LIMITS,
    );
    createArgs.push(...resourceFlags);

    // Network isolation (custom or default)
    const networkFlags = buildNetworkFlag(params.cfg.networkMode ?? DEFAULT_NETWORK_MODE);
    createArgs.push(...networkFlags);

    // Environment variables with secret filtering
    if (params.cfg.env) {
      const filteredEnv = filterSecretsFromEnv(params.cfg.env);
      for (const [key, value] of Object.entries(filteredEnv)) {
        createArgs.push("--env", `${key}=${value}`);
      }
    }

    // Docker image (must be last)
    createArgs.push(params.cfg.docker.image);

    // Create the container
    await execDocker(createArgs);

    // Start the container
    await execDocker(["start", containerName]);

    return containerName;
  }

  async exec(_containerName: string, args: string[], opts?: ExecOptions): Promise<ExecResult> {
    return execDockerRaw(args, opts);
  }

  async destroy(containerName: string, opts?: DestroyOptions): Promise<void> {
    const rmArgs = ["rm", ...(opts?.force ? ["-f"] : []), containerName];
    await execDocker(rmArgs);
  }

  async status(containerName: string): Promise<SandboxState> {
    return dockerContainerState(containerName);
  }

  async list(): Promise<SandboxInfo[]> {
    const containers = await listSandboxContainers();
    return containers.map((c) => ({
      containerName: c.containerName,
      sessionKey: c.sessionKey,
      running: c.running,
      image: c.image,
    }));
  }

  /**
   * Copy a file or directory from the host into the sandbox container.
   */
  async syncToSandbox(
    containerName: string,
    hostPath: string,
    containerPath: string,
  ): Promise<void> {
    return fsSyncToSandbox(containerName, hostPath, containerPath);
  }

  /**
   * Copy a file or directory from the sandbox container to the host.
   */
  async syncFromSandbox(
    containerName: string,
    containerPath: string,
    hostPath: string,
  ): Promise<void> {
    return fsSyncFromSandbox(containerName, containerPath, hostPath);
  }

  // --- IBrowserCapable delegation ---

  async launchBrowser(
    sandboxId: string,
    config?: SandboxBrowserConfig,
  ): Promise<BrowserSessionResult> {
    return this.getBrowserHelper().launchBrowser(sandboxId, config);
  }

  async navigateBrowser(
    sandboxId: string,
    sessionId: string,
    url: string,
    timeoutMs?: number,
  ): Promise<{ url: string; title: string }> {
    return this.getBrowserHelper().navigateBrowser(sandboxId, sessionId, url, timeoutMs);
  }

  async clickBrowser(sandboxId: string, sessionId: string, selector: string): Promise<void> {
    return this.getBrowserHelper().clickBrowser(sandboxId, sessionId, selector);
  }

  async typeBrowser(
    sandboxId: string,
    sessionId: string,
    selector: string,
    text: string,
  ): Promise<void> {
    return this.getBrowserHelper().typeBrowser(sandboxId, sessionId, selector, text);
  }

  async screenshotBrowser(
    sandboxId: string,
    sessionId: string,
    opts?: { fullPage?: boolean; quality?: number },
  ): Promise<BrowserScreenshotResult> {
    return this.getBrowserHelper().screenshotBrowser(sandboxId, sessionId, opts);
  }

  async evaluateJS(sandboxId: string, sessionId: string, expression: string): Promise<string> {
    return this.getBrowserHelper().evaluateJS(sandboxId, sessionId, expression);
  }

  async extractContent(
    sandboxId: string,
    sessionId: string,
    selector: string,
  ): Promise<{ text: string; html: string }> {
    return this.getBrowserHelper().extractContent(sandboxId, sessionId, selector);
  }

  async waitForSelector(
    sandboxId: string,
    sessionId: string,
    selector: string,
    timeoutMs?: number,
  ): Promise<boolean> {
    return this.getBrowserHelper().waitForSelector(sandboxId, sessionId, selector, timeoutMs);
  }

  async getPageInfo(sandboxId: string, sessionId: string): Promise<BrowserPageInfo> {
    return this.getBrowserHelper().getPageInfo(sandboxId, sessionId);
  }

  async closeBrowser(sandboxId: string, sessionId: string): Promise<void> {
    return this.getBrowserHelper().closeBrowser(sandboxId, sessionId);
  }
}
