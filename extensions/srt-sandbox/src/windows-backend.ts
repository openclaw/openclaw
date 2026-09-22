// SRT sandbox backend — Windows path (Stage S6, design v8 §4/§5/§7).
//
// The Windows analogue of SrtSandboxBackend (backend.ts). Windows enforcement is
// CLI-based (`srt-win.exe`) rather than a persistent SandboxManager, so this
// backend:
//   - provisions a per-scope low-privilege account + WFP sublayer + loopback
//     port range on first use (distinct SID + SID-keyed WFP filter set per scope
//     = per-scope filesystem + network isolation, AC-S6-1), grants the sandbox
//     account read+execute on the helper-path chain (the seclogon deployment-ACL
//     fix), grants its writable roots, and verifies the WFP egress fence is live
//     (fail-closed under the deny posture, AC-S6-3);
//   - runs every command through the Job-Object worker (windows-reaper.ts) so
//     the whole srt-win tree is reaped on scope teardown / worker crash / Gateway
//     crash (AC-S6-4);
//   - exposes the AC4 fs bridge (fs-bridge.ts, reused verbatim) backed by the
//     Windows NtCreateFile live-handle pin owner spawned INSIDE the sandbox via
//     `srt-win exec` (AC-S6-2), driven by the shared PinOwnerClient.
//
// Additive and plugin-confined: it does not touch the macOS (S1/S3) or Linux
// (S5) code paths, which keep using SrtSandboxBackend.
import { rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  grantWindowsAcl,
  installWindowsSandboxAsync,
  revokeWindowsAcl,
  verifyWindowsWfpEgress,
  type SrtWinSpawn,
} from "@anthropic-ai/sandbox-runtime";
import type {
  CreateSandboxBackendParams,
  SandboxBackendCommandParams,
  SandboxBackendCommandResult,
  SandboxBackendHandle,
} from "openclaw/plugin-sdk/sandbox";
import { shellEscape } from "openclaw/plugin-sdk/sandbox";
import type { ResolvedSrtPluginConfig } from "./config.js";
import { createSrtFsBridge } from "./fs-bridge.js";
import { PinOwnerClient } from "./pin-owner-client.js";
import { resolveWritableRoots, type SrtScopePolicyInput } from "./srt-runtime-config.js";
import {
  buildWindowsPinOwnerInnerArgs,
  PIN_OWNER_POWERSHELL,
  WINDOWS_PIN_OWNER_SCRIPT_NAME,
} from "./windows-pin-owner-source.js";
import { WindowsScopeReaper } from "./windows-reaper.js";
import {
  buildWindowsExecSpec,
  deriveWindowsScopeIdentity,
  ensureWindowsHelperPathAccess,
  resolveWindowsSrtWin,
  type WindowsScopeIdentity,
} from "./windows-sandbox-config.js";

const SRT_SANDBOX_BACKEND_ID = "srt";

// `shellEscape` is imported to keep the plugin-sdk sandbox surface in use for
// parity with the POSIX backend; positional args are passed via env, not the
// command string (see runShellCommand), so no cmd-quoting is needed here.
void shellEscape;

/** Expose positional args to the sandboxed script as SRT_ARG1..n env vars. */
function positionalArgEnv(args: readonly string[] | undefined): Record<string, string> {
  const env: Record<string, string> = {};
  if (args) {
    args.forEach((arg, i) => {
      env[`SRT_ARG${i + 1}`] = arg;
    });
  }
  return env;
}

export class WindowsSrtSandboxBackend {
  private readonly srtWin: SrtWinSpawn;
  private readonly identity: WindowsScopeIdentity;
  private readonly reaper = new WindowsScopeReaper();
  private readonly writableRoots: string[];
  private provisioning: Promise<string> | undefined;
  private sandboxUserSid: string | undefined;
  private pinOwnerClient: PinOwnerClient | undefined;
  private fsBridge: ReturnType<typeof createSrtFsBridge> | undefined;
  private pinOwnerScriptPath: string | undefined;

  constructor(
    private readonly params: CreateSandboxBackendParams,
    private readonly deps: { pluginConfig: ResolvedSrtPluginConfig },
    scopeIndex: number,
  ) {
    this.srtWin = resolveWindowsSrtWin(deps.pluginConfig.windows ?? {});
    this.identity = deriveWindowsScopeIdentity(
      params.scopeKey,
      scopeIndex,
      deps.pluginConfig.windows ?? {},
    );
    this.writableRoots = resolveWritableRoots(this.scopePolicy(), deps.pluginConfig.writablePaths);
  }

  get scopeKey(): string {
    return this.params.scopeKey;
  }

  private scopePolicy(): SrtScopePolicyInput {
    return {
      workspaceDir: this.params.workspaceDir,
      agentWorkspaceDir: this.params.agentWorkspaceDir,
      skillsWorkspaceDir: this.params.skillsWorkspaceDir,
      workspaceAccess: this.params.cfg.workspaceAccess,
    };
  }

  /**
   * Provision this scope's Windows enforcement on first use (idempotent):
   * install the per-scope account + WFP sublayer + loopback range, grant the
   * account helper-path read+execute and its writable roots, and verify the WFP
   * egress fence is live (fail-closed under deny). Returns the sandbox-user SID.
   */
  private async ensureProvisioned(): Promise<string> {
    if (this.sandboxUserSid) {
      return this.sandboxUserSid;
    }
    if (!this.provisioning) {
      this.provisioning = this.provision().finally(() => {
        this.provisioning = undefined;
      });
    }
    return this.provisioning;
  }

  private async provision(): Promise<string> {
    const result = await installWindowsSandboxAsync({
      sandboxUser: this.identity.sandboxUser,
      sublayerGuid: this.identity.sublayerGuid,
      proxyPortRange: this.identity.proxyPortRange,
      force: true,
      srtWin: this.srtWin,
    });
    const sid = result.user?.sid;
    if (!result.user?.provisioned || !sid) {
      throw new Error(
        `srt-sandbox: Windows sandbox account '${this.identity.sandboxUser}' was not provisioned`,
      );
    }
    // The seclogon two-hop launch must be able to open srt-win.exe as the sandbox
    // account; a per-user npm-global prefix is not traversable by default.
    ensureWindowsHelperPathAccess(this.identity.sandboxUser, this.srtWin);
    // Grant the scope's writable roots to the sandbox SID (deny-by-default fs).
    if (this.writableRoots.length > 0) {
      grantWindowsAcl({
        write: this.writableRoots,
        read: [],
        sandboxUserSid: sid,
        holderPid: process.pid,
        srtWin: this.srtWin,
      });
    }
    // Fail-closed egress check under the deny posture: prove the WFP fence blocks
    // direct egress (WSAEACCES policy-denial), mirroring XIN-1937 / AC-S6-3.
    if (this.deps.pluginConfig.network === "deny") {
      await verifyWindowsWfpEgress({ srtWin: this.srtWin });
    }
    this.sandboxUserSid = sid;
    return sid;
  }

  private async runShellCommand(
    params: SandboxBackendCommandParams,
  ): Promise<SandboxBackendCommandResult> {
    params.signal?.throwIfAborted();
    await this.ensureProvisioned();
    const { argv, env } = buildWindowsExecSpec({
      command: params.script,
      cwd: this.params.workspaceDir,
      allowWrite: this.writableRoots,
      srtWin: this.srtWin,
      setEnvVars: positionalArgEnv(params.args),
    });
    const result = await this.reaper.exec({
      argv,
      env,
      cwd: this.params.workspaceDir,
      stdin: params.stdin,
      timeoutMs: this.deps.pluginConfig.commandTimeoutMs,
    });
    if (!params.allowFailure && result.code !== 0) {
      throw new Error(
        `srt-sandbox windows command failed (exit ${result.code}): ${result.stderr.toString("utf8").trim()}`,
      );
    }
    return { stdout: result.stdout, stderr: result.stderr, code: result.code };
  }

  /**
   * Stage the pin-owner PowerShell to a file the scope account can read, inside
   * a granted writable root, so it can be launched with `powershell -File`
   * (the argv stays small — see buildWindowsPinOwnerInnerArgs). Written with a
   * UTF-8 BOM so `-File` decodes the Unicode content unambiguously. Idempotent.
   */
  private stagePinOwnerScript(): string {
    if (this.pinOwnerScriptPath) {
      return this.pinOwnerScriptPath;
    }
    const scriptPath = path.join(this.params.workspaceDir, WINDOWS_PIN_OWNER_SCRIPT_NAME);
    // Leading UTF-8 BOM so PowerShell's `-File` decodes the Unicode content.
    writeFileSync(scriptPath, "\uFEFF" + PIN_OWNER_POWERSHELL, { encoding: "utf8" });
    this.pinOwnerScriptPath = scriptPath;
    return scriptPath;
  }

  /** Spawn the NtCreateFile pin owner INSIDE the sandbox as the scope account. */
  private spawnPinOwner() {
    const scriptPath = this.stagePinOwnerScript();
    const inner = buildWindowsPinOwnerInnerArgs(scriptPath); // [powershell, ...flags, -File, <scriptPath>]
    const { argv, env } = buildWindowsExecSpec({
      command: scriptPath,
      cwd: this.params.workspaceDir,
      allowWrite: this.writableRoots,
      srtWin: this.srtWin,
      binShell: { exe: inner[0]!, args: inner.slice(1, -1) },
    });
    return this.reaper.spawnPersistent({ argv, env, cwd: this.params.workspaceDir });
  }

  dispose(): void {
    this.fsBridge?.dispose();
    this.fsBridge = undefined;
    this.pinOwnerClient?.dispose();
    this.pinOwnerClient = undefined;
    this.reaper.dispose();
    if (this.pinOwnerScriptPath) {
      try {
        rmSync(this.pinOwnerScriptPath, { force: true });
      } catch {
        // Best-effort cleanup of the staged pin-owner script.
      }
      this.pinOwnerScriptPath = undefined;
    }
    // Release this scope's additive ACL grants (refcounted by holderPid).
    if (this.sandboxUserSid) {
      try {
        revokeWindowsAcl({
          sandboxUserSid: this.sandboxUserSid,
          holderPid: process.pid,
          srtWin: this.srtWin,
        });
      } catch {
        // Best-effort release; a leaked additive ACE is not a correctness issue.
      }
    }
  }

  asHandle(): SandboxBackendHandle {
    const runShellCommand = (params: SandboxBackendCommandParams) => this.runShellCommand(params);
    return {
      id: SRT_SANDBOX_BACKEND_ID,
      runtimeId: this.params.scopeKey,
      runtimeLabel: `srt-win:${this.params.scopeKey}`,
      workdir: this.params.workspaceDir,
      env: this.params.cfg.docker.env,
      configLabel: this.identity.sandboxUser,
      configLabelKind: "Account",
      capabilities: { browser: false },
      buildExecSpec: async ({ command, workdir }) => {
        await this.ensureProvisioned();
        const { argv, env } = buildWindowsExecSpec({
          command,
          cwd: workdir ?? this.params.workspaceDir,
          allowWrite: this.writableRoots,
          srtWin: this.srtWin,
        });
        return { argv, env, cwd: workdir ?? this.params.workspaceDir, stdinMode: "pipe-open" };
      },
      runShellCommand,
      createFsBridge: ({ sandbox }) => {
        if (!this.fsBridge) {
          const writableRoots = resolveWritableRoots(
            {
              workspaceDir: sandbox.workspaceDir,
              agentWorkspaceDir: sandbox.agentWorkspaceDir,
              skillsWorkspaceDir: sandbox.skillsWorkspaceDir,
              workspaceAccess: sandbox.workspaceAccess,
            },
            this.deps.pluginConfig.writablePaths,
          );
          this.pinOwnerClient = new PinOwnerClient({
            spawnOwner: async () => {
              await this.ensureProvisioned();
              return this.spawnPinOwner();
            },
            rpcTimeoutMs: this.deps.pluginConfig.commandTimeoutMs,
          });
          this.fsBridge = createSrtFsBridge({
            sandbox,
            writableRoots,
            client: this.pinOwnerClient,
          });
        }
        return this.fsBridge;
      },
    };
  }
}
