import { PATH_ALIAS_POLICIES } from "@openclaw/fs-safe/advanced";
/**
 * Shell plans for pinned sandbox filesystem operations.
 *
 * Selects the local interpreter and supplies quoted Python source to local and remote transports.
 */
import { GUEST_FILESYSTEM_PYTHON } from "@openclaw/fs-safe/guest";
import type {
  PathSafetyCheck,
  PinnedSandboxDirectoryEntry,
  PinnedSandboxEntry,
} from "./fs-bridge-path-safety.js";
import type { SandboxResolvedFsPath } from "./fs-paths.js";

// Plans carry path-safety checks alongside the command so rechecks and execution stay coupled.
export type SandboxFsCommandPlan = {
  checks: PathSafetyCheck[];
  script: string;
  args?: string[];
  stdin?: Buffer | string;
  recheckBeforeCommand?: boolean;
  allowFailure?: boolean;
};

const SANDBOX_PINNED_MUTATION_PYTHON_CANDIDATES = [
  "/usr/bin/python3",
  "/usr/local/bin/python3",
  "/opt/homebrew/bin/python3",
  "/bin/python3",
] as const;

export const PINNED_MUTATION_ACTION_LABELS = {
  write: "write files",
  create: "create files",
  mkdir: "create directories",
  remove: "remove files",
  "copy-destination": "copy files",
} as const;

export const SANDBOX_PINNED_MUTATION_PYTHON_SHELL_LITERAL = `'${GUEST_FILESYSTEM_PYTHON.replaceAll("'", `'\\''`)}'`;

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
      target: SandboxResolvedFsPath;
    })
  | (Extract<PinnedSandboxOperation, { kind: "copy" | "rename" }> & {
      sourceTarget: SandboxResolvedFsPath;
      destinationTarget: SandboxResolvedFsPath;
    });

const PINNED_OPERATION_CHECK_OPTIONS = {
  write: { action: "write files", requireWritable: true },
  create: { action: "create files", requireWritable: true },
  readdir: { action: "list directories", allowedType: "directory" },
  mkdirp: { action: "create directories", requireWritable: true, allowedType: "directory" },
  remove: { action: "remove files", requireWritable: true, allowedType: "file-or-directory" },
  rename: { action: "rename files", requireWritable: "subtree", allowedType: "file-or-directory" },
  copy: { action: "copy files", requireWritable: true },
} satisfies Record<CheckedPinnedOperation["kind"], PathSafetyCheck["options"]>;

export function buildPinnedMutationPlan(operation: CheckedPinnedOperation): SandboxFsCommandPlan {
  const options: PathSafetyCheck["options"] = { ...PINNED_OPERATION_CHECK_OPTIONS[operation.kind] };
  if (operation.kind === "remove" && operation.recursive) {
    options.requireWritable = "subtree";
  }
  const checks: PathSafetyCheck[] =
    operation.kind === "copy" || operation.kind === "rename"
      ? [
          {
            target: operation.sourceTarget,
            options:
              operation.kind === "copy" ? { action: options.action, allowedType: "file" } : options,
          },
          { target: operation.destinationTarget, options },
        ]
      : [{ target: operation.target, options }];
  if (operation.kind === "remove" || operation.kind === "rename") {
    checks[0]!.options = { ...checks[0]!.options, aliasPolicy: PATH_ALIAS_POLICIES.unlinkTarget };
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
