/**
 * Shell plans for pinned sandbox filesystem operations.
 *
 * Selects the local interpreter and supplies quoted Python source to local and remote transports.
 */
import { PATH_ALIAS_POLICIES } from "../../infra/path-alias-guards.js";
import { SANDBOX_PINNED_MUTATION_PYTHON } from "./fs-bridge-mutation-python.js";
import type {
  PathSafetyCheck,
  PinnedSandboxDirectoryEntry,
  PinnedSandboxEntry,
} from "./fs-bridge-path-safety.js";
import type { SandboxFsCommandPlan } from "./fs-bridge-shell-command-plans.js";

const SANDBOX_PINNED_MUTATION_PYTHON_CANDIDATES = [
  "/usr/bin/python3",
  "/usr/local/bin/python3",
  "/opt/homebrew/bin/python3",
  "/bin/python3",
] as const;

export const SANDBOX_PINNED_MUTATION_PYTHON_SHELL_LITERAL = `'${SANDBOX_PINNED_MUTATION_PYTHON.replaceAll("'", `'\\''`)}'`;

export type PinnedSandboxOperation =
  | {
      kind: "read";
      pinned: PinnedSandboxEntry;
      maxBytes?: number;
    }
  | {
      kind: "write" | "create";
      pinned: PinnedSandboxEntry;
      mkdir: boolean;
    }
  | {
      kind: "mkdirp" | "readdir";
      pinned: PinnedSandboxDirectoryEntry;
    }
  | {
      kind: "remove";
      pinned: PinnedSandboxEntry;
      recursive?: boolean;
      force?: boolean;
    }
  | {
      kind: "copy";
      source: PinnedSandboxEntry;
      destination: PinnedSandboxEntry;
      mkdir: boolean;
    }
  | {
      kind: "rename";
      source: PinnedSandboxEntry;
      destination: PinnedSandboxEntry;
    };

function pinnedEntryArgs(pinned: PinnedSandboxEntry): string[] {
  return [pinned.mountRootPath, pinned.relativeParentPath, pinned.basename];
}

/** Encode only already-admitted pinned facts; transport and path checks stay with each bridge. */
export function buildPinnedMutationArgs(operation: PinnedSandboxOperation): string[] {
  switch (operation.kind) {
    case "read":
      return [
        operation.kind,
        ...pinnedEntryArgs(operation.pinned),
        ...(operation.maxBytes === undefined ? [] : [String(operation.maxBytes)]),
      ];
    case "write":
    case "create":
      return [operation.kind, ...pinnedEntryArgs(operation.pinned), operation.mkdir ? "1" : "0"];
    case "mkdirp":
    case "readdir":
      return [operation.kind, operation.pinned.mountRootPath, operation.pinned.relativePath];
    case "remove":
      return [
        operation.kind,
        ...pinnedEntryArgs(operation.pinned),
        operation.recursive ? "1" : "0",
        operation.force === false ? "0" : "1",
      ];
    case "copy":
    case "rename":
      break;
  }
  return [
    operation.kind,
    ...pinnedEntryArgs(operation.source),
    ...pinnedEntryArgs(operation.destination),
    operation.kind === "rename" || operation.mkdir ? "1" : "0",
  ];
}

type CheckedPinnedOperation =
  | (Exclude<PinnedSandboxOperation, { kind: "read" | "copy" | "rename" }> & {
      check: PathSafetyCheck;
    })
  | (Extract<PinnedSandboxOperation, { kind: "copy" | "rename" }> & {
      sourceCheck: PathSafetyCheck;
      destinationCheck: PathSafetyCheck;
    });

export function buildPinnedMutationPlan(operation: CheckedPinnedOperation): SandboxFsCommandPlan {
  const checks =
    operation.kind === "copy" || operation.kind === "rename"
      ? [operation.sourceCheck, operation.destinationCheck]
      : [operation.check];
  if (operation.kind === "remove" || operation.kind === "rename") {
    const check = operation.kind === "remove" ? operation.check : operation.sourceCheck;
    checks[0] = {
      target: check.target,
      options: { ...check.options, aliasPolicy: PATH_ALIAS_POLICIES.unlinkTarget },
    };
  }
  const args = buildPinnedMutationArgs(operation);
  return {
    checks,
    recheckBeforeCommand: true,
    // -c executes reliably on older Python builds while stdin carries payload bytes.
    script: [
      "set -eu",
      "python_cmd=''",
      ...SANDBOX_PINNED_MUTATION_PYTHON_CANDIDATES.map(
        (candidate) =>
          `if [ -z "$python_cmd" ] && [ -x '${candidate}' ]; then python_cmd='${candidate}'; fi`,
      ),
      'if [ -z "$python_cmd" ]; then python_cmd=$(command -v python3 2>/dev/null || command -v python 2>/dev/null || true); fi',
      'if [ -z "$python_cmd" ]; then',
      "  echo >&2 'sandbox pinned mutation helper requires python3 or python'",
      "  exit 127",
      "fi",
      `python_script=${SANDBOX_PINNED_MUTATION_PYTHON_SHELL_LITERAL}`,
      'exec "$python_cmd" -c "$python_script" "$@"',
    ].join("\n"),
    args,
  };
}
