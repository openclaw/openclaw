import { createSubsystemLogger } from "../../../logging/subsystem.js";
import { ExecBrowserHelper } from "../browser/exec-browser.js";
import { execDockerRaw, execDocker, dockerContainerState } from "../docker.js";
import {
  DEFAULT_RESOURCE_LIMITS,
  buildResourceLimitFlags,
  DEFAULT_NETWORK_MODE,
  buildNetworkFlag,
  filterSecretsFromEnv,
  syncToSandbox as fsSyncToSandbox,
  syncFromSandbox as fsSyncFromSandbox,
} from "../hardening/index.js";
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

const log = createSubsystemLogger("gvisor-provider");

/** Container name prefix for gVisor sandbox containers. */
const CONTAINER_PREFIX = "openclaw-gvisor-";

/**
 * GVisorProvider — sandbox backend using Docker with the gVisor (runsc) runtime.
 *
 * Uses composition over Docker CLI functions (same execDocker/execDockerRaw as
 * DockerProvider) but adds --runtime=runsc for container creation and runsc-specific
 * health detection. The provider-resolver already imports GVisorProvider, so once
 * checkHealth() returns available=true, auto-detection will select gVisor over Docker.
 */
export class GVisorProvider implements ISandboxProvider, IBrowserCapable {
  readonly name = "gvisor" as const;
  private browserHelper: ExecBrowserHelper | null = null;

  private getBrowserHelper(): ExecBrowserHelper {
    if (!this.browserHelper) {
      this.browserHelper = new ExecBrowserHelper((containerName, args, opts) =>
        this.exec(containerName, args, opts),
      );
    }
    return this.browserHelper;
  }

  /**
   * Two-stage health detection:
   * 1. Fast: Check if runsc is registered in Docker runtimes via `docker info`
   * 2. Functional: Run a test container with `--runtime=runsc` to validate compatibility
   */
  async checkHealth(): Promise<ProviderHealthResult> {
    try {
      // Stage 1: Check if runsc is registered in Docker runtimes
      const infoResult = await execDocker(["info", "--format", "{{json .Runtimes}}"], {
        allowFailure: true,
      });

      if (infoResult.code !== 0) {
        return {
          available: false,
          message: `Docker not available: ${infoResult.stderr.trim()}`,
        };
      }

      // Parse runtimes JSON and check for "runsc" key
      const runtimesStr = infoResult.stdout.trim();
      if (!runtimesStr.includes('"runsc"')) {
        return {
          available: false,
          message: "gVisor runtime (runsc) not registered in Docker runtimes",
        };
      }

      // Stage 2: Functional validation — run a test container with runsc
      const testResult = await execDocker(["run", "--rm", "--runtime=runsc", "hello-world"], {
        allowFailure: true,
      });

      if (testResult.code !== 0) {
        return {
          available: false,
          message: `gVisor runtime test failed: ${testResult.stderr.trim()}`,
        };
      }

      log.info("gVisor (runsc) runtime available and functional");
      return {
        available: true,
        message: "gVisor (runsc) runtime available and functional",
        version: "gVisor runsc",
      };
    } catch (err) {
      return {
        available: false,
        message: `gVisor health check error: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  /**
   * Create or reuse a Docker container with the gVisor (runsc) runtime.
   *
   * Builds Docker create args with:
   * - --runtime=runsc for gVisor kernel isolation
   * - --label openclaw.runtime=runsc for container identification
   * - Resource limit flags (from config or defaults)
   * - Network mode flag (from config or defaults)
   * - Filtered environment variables (secrets removed)
   */
  async ensureSandbox(params: EnsureSandboxParams): Promise<string> {
    const containerName = `${CONTAINER_PREFIX}${params.sessionKey}`;

    // Check if container already exists
    const state = await dockerContainerState(containerName);
    if (state.exists && state.running) {
      log.debug(`Container ${containerName} already running`);
      return containerName;
    }

    if (state.exists && !state.running) {
      // Container exists but stopped — restart it
      log.debug(`Starting existing container ${containerName}`);
      await execDocker(["start", containerName]);
      return containerName;
    }

    // Build Docker create command args
    const createArgs: string[] = [
      "create",
      "--name",
      containerName,
      "--runtime=runsc",
      "--label",
      "openclaw.runtime=runsc",
    ];

    // Add resource limit flags
    const resourceLimits = params.cfg.resourceLimits ?? DEFAULT_RESOURCE_LIMITS;
    createArgs.push(...buildResourceLimitFlags(resourceLimits));

    // Add network flag
    const networkMode = params.cfg.networkMode ?? DEFAULT_NETWORK_MODE;
    createArgs.push(...buildNetworkFlag(networkMode));

    // Environment variables with secret filtering
    if (params.cfg.env) {
      const filteredEnv = filterSecretsFromEnv(params.cfg.env);
      for (const [key, value] of Object.entries(filteredEnv)) {
        createArgs.push("--env", `${key}=${value}`);
      }
    }

    // Add image
    createArgs.push(params.cfg.docker.image);

    // Create the container
    log.info(`Creating gVisor container: ${containerName}`);
    await execDocker(createArgs);

    // Start the container
    await execDocker(["start", containerName]);

    return containerName;
  }

  /**
   * Execute a command inside the sandbox container.
   * Delegates to execDockerRaw identically to DockerProvider.
   * Runtime flag is NOT needed for exec (only for container creation).
   */
  async exec(_containerName: string, args: string[], opts?: ExecOptions): Promise<ExecResult> {
    return execDockerRaw(args, opts);
  }

  /**
   * Remove the sandbox container.
   * Same as DockerProvider — delegates to `docker rm [-f]`.
   */
  async destroy(containerName: string, opts?: DestroyOptions): Promise<void> {
    const rmArgs = ["rm", ...(opts?.force ? ["-f"] : []), containerName];
    await execDocker(rmArgs);
  }

  /**
   * Check container state (exists + running).
   * Delegates to dockerContainerState identically to DockerProvider.
   */
  async status(containerName: string): Promise<SandboxState> {
    return dockerContainerState(containerName);
  }

  /**
   * List all sandbox containers.
   * Delegates to listSandboxContainers and maps results to SandboxInfo[].
   */
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
