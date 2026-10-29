import { randomUUID } from "node:crypto";
import type { SandboxBackendHandle } from "./backend-handle.types.js";

const SANDBOX_PROCESS_REAP_TIMEOUT_MS = 4_500;
const SANDBOX_REMOTE_PROCESS_PENDING_EXIT_CODE = 75;
const SANDBOX_EXEC_MARKER = "CODEX_SANDBOX_EXEC_ID";

export function prepareSandboxProcessCleanup(
  backend: SandboxBackendHandle,
  env: Record<string, string>,
): ReturnType<typeof createSandboxProcessCleanup> {
  return (
    backend.prepareProcessCleanup?.(env) ??
    createSandboxProcessCleanup(backend.runShellCommand.bind(backend), env)
  );
}

/** Only termination retains cleanup custody; interrupts still require current execution authority. */
export function createSandboxProcessCleanup(
  runShellCommand: SandboxBackendHandle["runShellCommand"],
  env: Record<string, string>,
  runTermination: SandboxBackendHandle["runShellCommand"] = runShellCommand,
): {
  env: Record<string, string>;
  terminate: () => Promise<void>;
  interrupt: (timeoutMs: number) => Promise<boolean>;
} {
  const marker = randomUUID();
  return {
    env: { ...env, [SANDBOX_EXEC_MARKER]: marker },
    interrupt: async (timeoutMs) => {
      const result = await runShellCommand({
        script: `${SANDBOX_REMOTE_FIND_OWNED_PIDS}\nowned="$(find_owned_pids "$1")"\n[ -n "$owned" ] || exit ${SANDBOX_REMOTE_PROCESS_PENDING_EXIT_CODE}\nkill -INT $owned 2>/dev/null || true`,
        args: [`${SANDBOX_EXEC_MARKER}=${marker}`],
        allowFailure: true,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (result.code === SANDBOX_REMOTE_PROCESS_PENDING_EXIT_CODE) {
        return false;
      }
      if (result.code !== 0) {
        throw new Error(`Sandbox process interrupt failed with code ${result.code}`);
      }
      return true;
    },
    terminate: async () => {
      const result = await runTermination({
        script: SANDBOX_REMOTE_TERMINATE_SCRIPT,
        args: [`${SANDBOX_EXEC_MARKER}=${marker}`],
        allowFailure: true,
        signal: AbortSignal.timeout(SANDBOX_PROCESS_REAP_TIMEOUT_MS),
      });
      if (result.code !== 0) {
        const detail =
          result.stderr.toString("utf8").trim() || result.stdout.toString("utf8").trim();
        throw new Error(
          detail ||
            `Sandbox process tree cleanup failed with code ${result.code}; tear down the sandbox environment and inspect surviving processes before retrying.`,
        );
      }
    },
  };
}

const SANDBOX_REMOTE_FIND_OWNED_PIDS = String.raw`
find_owned_pids() {
  for env_file in /proc/[0-9]*/environ; do
    if [ -r "$env_file" ] && tr '\0' '\n' < "$env_file" 2>/dev/null | grep -Fqx "$1"; then
      basename "$(dirname "$env_file")"
    fi
  done
}
`.trim();

const SANDBOX_REMOTE_TERMINATE_SCRIPT = String.raw`
${SANDBOX_REMOTE_FIND_OWNED_PIDS}
owned="$(find_owned_pids "$1")"
[ -z "$owned" ] || kill -TERM $owned 2>/dev/null || true
sleep 1
owned="$(find_owned_pids "$1")"
[ -z "$owned" ] || kill -KILL $owned 2>/dev/null || true
sleep 1
owned="$(find_owned_pids "$1")"
[ -z "$owned" ] || { echo "Sandbox process IDs survived SIGKILL: $owned" >&2; exit 1; }
`.trim();
