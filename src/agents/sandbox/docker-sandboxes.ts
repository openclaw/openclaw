/**
 * Docker Sandboxes (microVM) backend.
 *
 * Uses `docker sandbox` CLI commands (Docker Desktop 4.58+) to run
 * agent workloads in isolated microVMs instead of plain containers.
 *
 * Key differences from the container backend:
 * - Each sandbox runs in its own microVM with a private Docker daemon
 * - Workspace syncs bidirectionally at the same absolute path
 * - Sandboxes don't appear in `docker ps`; use `docker sandbox ls`
 * - Hypervisor-level isolation (macOS: virtualization.framework, Windows: Hyper-V)
 */

import { spawn } from "node:child_process";
import type { SandboxConfig, SandboxMicrovmConfig } from "./types.js";
import { formatCliCommand } from "../../cli/command-format.js";
import { defaultRuntime } from "../../runtime.js";
import { computeMicrovmConfigHash } from "./config-hash.js";
import { DEFAULT_SANDBOX_MICROVM_TEMPLATE } from "./constants.js";
import { readRegistry, updateRegistry } from "./registry.js";
import { resolveSandboxAgentId, resolveSandboxScopeKey, slugifySessionKey } from "./shared.js";

const HOT_SANDBOX_WINDOW_MS = 5 * 60 * 1000;

/**
 * Execute a `docker sandbox` subcommand.
 *
 * NOTE: The `error` event handling here is an improvement over `execDocker` in
 * docker.ts — worth backporting to prevent unhandled rejections when the
 * `docker` binary is missing or spawn fails.
 */
export function execDockerSandbox(args: string[], opts?: { allowFailure?: boolean }) {
  return new Promise<{ stdout: string; stderr: string; code: number }>((resolve, reject) => {
    const child = spawn("docker", ["sandbox", ...args], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", (err) => {
      if (opts?.allowFailure) {
        resolve({ stdout, stderr: err.message, code: 1 });
        return;
      }
      reject(new Error(`docker sandbox ${args.join(" ")} failed: ${err.message}`));
    });
    child.on("close", (code) => {
      const exitCode = code ?? 0;
      if (exitCode !== 0 && !opts?.allowFailure) {
        reject(new Error(stderr.trim() || `docker sandbox ${args.join(" ")} failed`));
        return;
      }
      resolve({ stdout, stderr, code: exitCode });
    });
  });
}

/**
 * Check whether the `docker sandbox` CLI is available.
 * Returns true if the command exists and responds to `docker sandbox ls`.
 */
export async function isDockerSandboxAvailable(): Promise<boolean> {
  try {
    const result = await execDockerSandbox(["ls", "--quiet"], { allowFailure: true });
    return result.code === 0;
  } catch {
    return false;
  }
}

type SandboxState = {
  exists: boolean;
  running: boolean;
};

/**
 * Query the state of a Docker Sandbox by name via `docker sandbox ls --json`.
 *
 * TODO: This is O(n) — it fetches all sandboxes to check one name.
 * If `docker sandbox inspect <name>` becomes available, switch to that.
 * Alternatively, cache the `ls` result within a single resolution cycle.
 */
export async function dockerSandboxState(name: string): Promise<SandboxState> {
  const result = await execDockerSandbox(["ls", "--json"], { allowFailure: true });
  if (result.code !== 0) {
    return { exists: false, running: false };
  }

  try {
    const parsed = JSON.parse(result.stdout) as {
      vms?: Array<{
        name?: string;
        status?: string;
      }>;
    };
    const vm = parsed.vms?.find((v) => v.name === name);
    if (!vm) {
      return { exists: false, running: false };
    }
    return { exists: true, running: vm.status === "running" };
  } catch {
    return { exists: false, running: false };
  }
}

/**
 * Build `docker sandbox exec` args analogous to `buildDockerExecArgs` for containers.
 * Re-exported from bash-tools.shared.ts to avoid duplication.
 */
export { buildDockerSandboxExecArgs as buildSandboxExecArgs } from "../bash-tools.shared.js";

async function createMicrovmSandbox(params: {
  name: string;
  cfg: SandboxMicrovmConfig;
  workspaceDir: string;
}) {
  const { name, cfg, workspaceDir } = params;

  const createArgs = ["create", "--name", name];
  if (cfg.template) {
    createArgs.push("--template", cfg.template);
  }
  // Use a generic agent type — the sandbox will exec our commands directly.
  // We use "cagent" as a lightweight agent placeholder, or fall back to
  // workspace-only create if the CLI supports it.
  createArgs.push("cagent", workspaceDir);

  await execDockerSandbox(createArgs);

  // NOTE: setupCommand runs with full privileges inside the microVM, which has
  // its own private Docker daemon. A malicious command could spin up arbitrary
  // containers, pull images, etc. This is intentional for the advanced use case
  // but should be documented in config-facing types.
  if (cfg.setupCommand?.trim()) {
    const envArgs: string[] = [];
    for (const [key, value] of Object.entries(cfg.env ?? {})) {
      envArgs.push("-e", `${key}=${value}`);
    }
    await execDockerSandbox(["exec", ...envArgs, name, "sh", "-lc", cfg.setupCommand]);
  }
}

function formatMicrovmRecreateHint(params: { scope: SandboxConfig["scope"]; sessionKey: string }) {
  if (params.scope === "session") {
    return formatCliCommand(`openclaw sandbox recreate --session ${params.sessionKey}`);
  }
  if (params.scope === "agent") {
    const agentId = resolveSandboxAgentId(params.sessionKey) ?? "main";
    return formatCliCommand(`openclaw sandbox recreate --agent ${agentId}`);
  }
  return formatCliCommand("openclaw sandbox recreate --all");
}

/**
 * Compute a config hash that includes the microvm config for change detection.
 */
function computeMicrovmHash(params: {
  microvm: SandboxMicrovmConfig;
  workspaceDir: string;
  agentWorkspaceDir: string;
}) {
  return computeMicrovmConfigHash({
    template: params.microvm.template,
    sandboxPrefix: params.microvm.sandboxPrefix,
    env: params.microvm.env,
    setupCommand: params.microvm.setupCommand,
    workspaceDir: params.workspaceDir,
    agentWorkspaceDir: params.agentWorkspaceDir,
  });
}

/**
 * Ensure a Docker Sandbox (microVM) exists and is running.
 * Mirrors the contract of `ensureSandboxContainer` from docker.ts.
 */
export async function ensureMicrovmSandbox(params: {
  sessionKey: string;
  workspaceDir: string;
  agentWorkspaceDir: string;
  cfg: SandboxConfig;
}): Promise<string> {
  const available = await isDockerSandboxAvailable();
  if (!available) {
    throw new Error(
      "Docker Sandboxes (microVM) backend requires Docker Desktop 4.58+ with `docker sandbox` CLI. " +
        'Install or upgrade Docker Desktop, or switch to backend: "container" in your sandbox config.',
    );
  }

  const scopeKey = resolveSandboxScopeKey(params.cfg.scope, params.sessionKey);
  const slug = params.cfg.scope === "shared" ? "shared" : slugifySessionKey(scopeKey);
  const name = `${params.cfg.microvm.sandboxPrefix}${slug}`;
  // Docker sandbox names: letters, numbers, hyphens, underscores
  const sandboxName = name.slice(0, 63).replace(/[^a-zA-Z0-9_-]/g, "-");

  const expectedHash = computeMicrovmHash({
    microvm: params.cfg.microvm,
    workspaceDir: params.workspaceDir,
    agentWorkspaceDir: params.agentWorkspaceDir,
  });

  const now = Date.now();
  const state = await dockerSandboxState(sandboxName);
  let hasSandbox = state.exists;
  const running = state.running;

  if (hasSandbox) {
    const registry = await readRegistry();
    const registryEntry = registry.entries.find((entry) => entry.containerName === sandboxName);
    const currentHash = registryEntry?.configHash ?? null;
    const hashMismatch = !currentHash || currentHash !== expectedHash;

    if (hashMismatch) {
      const lastUsedAtMs = registryEntry?.lastUsedAtMs;
      const isHot =
        running && (typeof lastUsedAtMs !== "number" || now - lastUsedAtMs < HOT_SANDBOX_WINDOW_MS);

      if (isHot) {
        const hint = formatMicrovmRecreateHint({
          scope: params.cfg.scope,
          sessionKey: scopeKey,
        });
        defaultRuntime.log(
          `Sandbox config changed for ${sandboxName} (recently used). Recreate to apply: ${hint}`,
        );
      } else {
        await execDockerSandbox(["rm", sandboxName], { allowFailure: true });
        hasSandbox = false;
      }
    }
  }

  if (!hasSandbox) {
    await createMicrovmSandbox({
      name: sandboxName,
      cfg: params.cfg.microvm,
      workspaceDir: params.workspaceDir,
    });
  } else if (!running) {
    // Sandbox exists but is stopped — restart it.
    await execDockerSandbox(["run", sandboxName], { allowFailure: true });
  }

  await updateRegistry({
    containerName: sandboxName,
    sessionKey: scopeKey,
    createdAtMs: now,
    lastUsedAtMs: now,
    image: params.cfg.microvm.template ?? DEFAULT_SANDBOX_MICROVM_TEMPLATE,
    configHash: expectedHash,
    backend: "microvm",
  });

  return sandboxName;
}
