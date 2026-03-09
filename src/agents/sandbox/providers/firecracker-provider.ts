import {
  createSandboxClient,
  createExecClient,
  createHealthClient,
  createBrowserClient,
} from "../grpc/client.js";
import type { SandboxClient, ExecClient, BrowserClient } from "../grpc/client.js";
import { mapGrpcError } from "../grpc/errors.js";
import type { HealthClient } from "../grpc/health.js";
import { checkFirecrackerHealth } from "../grpc/health.js";
// @ts-expect-error -- Generated proto code; available at runtime after buf generate
import { SandboxState as ProtoSandboxState } from "../proto/openclaw/sandbox/v1/sandbox.js";
import type {
  ISandboxProvider,
  ProviderHealthResult,
  ExecResult,
  SandboxState,
  EnsureSandboxParams,
  ExecOptions,
  DestroyOptions,
  SandboxInfo,
  IBrowserCapable,
  BrowserSessionResult,
  BrowserScreenshotResult,
  BrowserPageInfo,
} from "../provider.js";
import type { SandboxBrowserConfig } from "../types.js";

const MAX_OUTPUT_BYTES = 10 * 1024 * 1024; // 10 MiB

/**
 * FirecrackerProvider — ISandboxProvider backed by Firecracker MicroVMs.
 *
 * Delegates all operations to the Go vm-runner via gRPC over a Unix socket.
 * Requires /dev/kvm and a running openclaw-vm-runner process.
 */
export class FirecrackerProvider implements ISandboxProvider, IBrowserCapable {
  readonly name = "firecracker" as const;

  private sandboxClient: SandboxClient = null as unknown as SandboxClient;
  private execClient: ExecClient = null as unknown as ExecClient;
  private healthClient: HealthClient = null as unknown as HealthClient;
  private browserClient: BrowserClient = null as unknown as BrowserClient;

  private getSandboxClient(): SandboxClient {
    if (this.sandboxClient === null) {
      this.sandboxClient = createSandboxClient();
    }
    return this.sandboxClient;
  }

  private getExecClient(): ExecClient {
    if (this.execClient === null) {
      this.execClient = createExecClient();
    }
    return this.execClient;
  }

  private getHealthClient(): HealthClient {
    if (this.healthClient === null) {
      this.healthClient = createHealthClient();
    }
    return this.healthClient;
  }

  private getBrowserClient(): BrowserClient {
    if (this.browserClient === null) {
      this.browserClient = createBrowserClient();
    }
    return this.browserClient;
  }

  async checkHealth(): Promise<ProviderHealthResult> {
    return checkFirecrackerHealth(this.getHealthClient());
  }

  async ensureSandbox(params: EnsureSandboxParams): Promise<string> {
    try {
      const response = await this.getSandboxClient().createSandbox({
        sandboxId: params.sessionKey,
      });
      return response.sandboxId;
    } catch (err) {
      throw mapGrpcError(err, "ensureSandbox");
    }
  }

  async exec(vmId: string, args: string[], opts?: ExecOptions): Promise<ExecResult> {
    try {
      const requestStream = (async function* () {
        yield {
          start: {
            sandboxId: vmId,
            command: args,
            workingDir: opts?.cwd ?? "",
            env: opts?.env ?? {},
            timeoutMs: opts?.timeout ?? 0,
          },
        };
      })();

      const responseStream = this.getExecClient().exec(requestStream);

      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let exitCode = -1;
      let totalSize = 0;
      let truncated = false;

      for await (const chunk of responseStream) {
        if (chunk.exit !== undefined) {
          exitCode = chunk.exit.exitCode;
        }

        if (truncated) {
          continue;
        }

        const stdoutData = chunk.stdoutData;
        const stderrData = chunk.stderrData;

        if (stdoutData !== undefined && stdoutData.length > 0) {
          const chunkSize = stdoutData.length;
          if (totalSize + chunkSize > MAX_OUTPUT_BYTES) {
            const remaining = MAX_OUTPUT_BYTES - totalSize;
            if (remaining > 0) {
              stdoutChunks.push(Buffer.from(stdoutData.subarray(0, remaining)));
            }
            truncated = true;
            stderrChunks.push(Buffer.from("\n[output truncated at 10 MiB]\n"));
            continue;
          }
          totalSize += chunkSize;
          stdoutChunks.push(Buffer.from(stdoutData));
        }

        if (stderrData !== undefined && stderrData.length > 0) {
          const chunkSize = stderrData.length;
          if (totalSize + chunkSize > MAX_OUTPUT_BYTES) {
            const remaining = MAX_OUTPUT_BYTES - totalSize;
            if (remaining > 0) {
              stderrChunks.push(Buffer.from(stderrData.subarray(0, remaining)));
            }
            truncated = true;
            stderrChunks.push(Buffer.from("\n[output truncated at 10 MiB]\n"));
            continue;
          }
          totalSize += chunkSize;
          stderrChunks.push(Buffer.from(stderrData));
        }
      }

      return {
        stdout: Buffer.concat(stdoutChunks),
        stderr: Buffer.concat(stderrChunks),
        code: exitCode,
      };
    } catch (err) {
      throw mapGrpcError(err, "exec");
    }
  }

  async destroy(vmId: string, opts?: DestroyOptions): Promise<void> {
    try {
      await this.getSandboxClient().destroySandbox({
        sandboxId: vmId,
        force: opts?.force ?? false,
      });
    } catch (err) {
      throw mapGrpcError(err, "destroy");
    }
  }

  async status(vmId: string): Promise<SandboxState> {
    try {
      const response = await this.getSandboxClient().sandboxStatus({
        sandboxId: vmId,
      });
      return {
        exists: response.state !== ProtoSandboxState.SANDBOX_STATE_UNSPECIFIED,
        running: response.state === ProtoSandboxState.SANDBOX_STATE_RUNNING,
      };
    } catch (err) {
      throw mapGrpcError(err, "status");
    }
  }

  async list(): Promise<SandboxInfo[]> {
    try {
      const response = await this.getSandboxClient().listSandboxes({});
      return response.sandboxes.map((s: { sandboxId: string; state: number }) => ({
        containerName: s.sandboxId,
        sessionKey: s.sandboxId,
        running: s.state === ProtoSandboxState.SANDBOX_STATE_RUNNING,
      }));
    } catch (err) {
      throw mapGrpcError(err, "list");
    }
  }

  // --- IBrowserCapable implementation ---

  async launchBrowser(
    sandboxId: string,
    config?: SandboxBrowserConfig,
  ): Promise<BrowserSessionResult> {
    try {
      const response = await this.getBrowserClient().launch({
        sandboxId,
        headless: config?.headless ?? true,
        viewportWidth: 1280,
        viewportHeight: 720,
      });
      return { sessionId: response.sessionId };
    } catch (err) {
      throw mapGrpcError(err, "launchBrowser");
    }
  }

  async navigateBrowser(
    sandboxId: string,
    sessionId: string,
    url: string,
    timeoutMs?: number,
  ): Promise<{ url: string; title: string }> {
    try {
      const response = await this.getBrowserClient().navigate({
        sandboxId,
        sessionId,
        url,
        timeoutMs: timeoutMs ?? 0,
      });
      return { url: response.url, title: response.title };
    } catch (err) {
      throw mapGrpcError(err, "navigateBrowser");
    }
  }

  async clickBrowser(sandboxId: string, sessionId: string, selector: string): Promise<void> {
    try {
      await this.getBrowserClient().click({
        sandboxId,
        sessionId,
        selector,
      });
    } catch (err) {
      throw mapGrpcError(err, "clickBrowser");
    }
  }

  async typeBrowser(
    sandboxId: string,
    sessionId: string,
    selector: string,
    text: string,
  ): Promise<void> {
    try {
      await this.getBrowserClient().type({
        sandboxId,
        sessionId,
        selector,
        text,
      });
    } catch (err) {
      throw mapGrpcError(err, "typeBrowser");
    }
  }

  async screenshotBrowser(
    sandboxId: string,
    sessionId: string,
    opts?: { fullPage?: boolean; quality?: number },
  ): Promise<BrowserScreenshotResult> {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of this.getBrowserClient().screenshot({
        sandboxId,
        sessionId,
        fullPage: opts?.fullPage ?? false,
        quality: opts?.quality ?? 0,
      })) {
        if (chunk.data && chunk.data.length > 0) {
          chunks.push(Buffer.from(chunk.data));
        }
        if (chunk.eof) {
          break;
        }
      }
      return { data: Buffer.concat(chunks) };
    } catch (err) {
      throw mapGrpcError(err, "screenshotBrowser");
    }
  }

  async evaluateJS(sandboxId: string, sessionId: string, expression: string): Promise<string> {
    try {
      const response = await this.getBrowserClient().evaluateJS({
        sandboxId,
        sessionId,
        expression,
      });
      return response.result;
    } catch (err) {
      throw mapGrpcError(err, "evaluateJS");
    }
  }

  async extractContent(
    sandboxId: string,
    sessionId: string,
    selector: string,
  ): Promise<{ text: string; html: string }> {
    try {
      const response = await this.getBrowserClient().extractContent({
        sandboxId,
        sessionId,
        selector,
      });
      return { text: response.text, html: response.html };
    } catch (err) {
      throw mapGrpcError(err, "extractContent");
    }
  }

  async waitForSelector(
    sandboxId: string,
    sessionId: string,
    selector: string,
    timeoutMs?: number,
  ): Promise<boolean> {
    try {
      const response = await this.getBrowserClient().waitForSelector({
        sandboxId,
        sessionId,
        selector,
        timeoutMs: timeoutMs ?? 0,
      });
      return response.found;
    } catch (err) {
      throw mapGrpcError(err, "waitForSelector");
    }
  }

  async getPageInfo(sandboxId: string, sessionId: string): Promise<BrowserPageInfo> {
    try {
      const response = await this.getBrowserClient().getPageInfo({
        sandboxId,
        sessionId,
      });
      return { title: response.title, url: response.url };
    } catch (err) {
      throw mapGrpcError(err, "getPageInfo");
    }
  }

  async closeBrowser(sandboxId: string, sessionId: string): Promise<void> {
    try {
      await this.getBrowserClient().close({
        sandboxId,
        sessionId,
      });
    } catch (err) {
      throw mapGrpcError(err, "closeBrowser");
    }
  }
}
