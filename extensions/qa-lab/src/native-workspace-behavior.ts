const nodeCommand = (source: string) => `node -e ${JSON.stringify(source)}`;

const QA_NATIVE_WORKSPACE_BEHAVIOR_IDS = [
  "bash",
  "edit",
  "exec",
  "fs-read",
  "fs-write",
  "grep",
] as const;

export type QaNativeWorkspaceBehaviorId = (typeof QA_NATIVE_WORKSPACE_BEHAVIOR_IDS)[number];

export type QaNativeWorkspaceBehavior = {
  id: QaNativeWorkspaceBehaviorId;
  nativeToolName: "bash" | "apply_patch";
  providerToolName: "exec_command" | "apply_patch";
  happyArgs: Record<string, unknown>;
  failureArgs: Record<string, unknown>;
  happyOutputMarker?: string;
  failureOutputMarker?: string;
  commandReceiptSignatures?: { happy: readonly string[]; failure: readonly string[] };
  seedFiles?: ReadonlyArray<{ path: string; contents: string }>;
  happyMutation?: { path: string; contents: string };
  failureSentinel?: { path: string; contents: string };
};

const EDIT_PATH = "runtime-tool-fixture-edit.txt";
const EDIT_DENIED_PATH = "../runtime-tool-fixture-edit-denied.txt";

function commandBehavior(id: "bash" | "exec", exitCode: number): QaNativeWorkspaceBehavior {
  const marker = `RUNTIME_NATIVE_${id.toUpperCase()}`;
  return {
    id,
    nativeToolName: "bash",
    providerToolName: "exec_command",
    happyArgs: {
      cmd: nodeCommand(`process.stdout.write('${marker}_OK\\n')`),
    },
    failureArgs: {
      cmd: nodeCommand(`process.stderr.write('${marker}_FAIL\\n'); process.exitCode = ${exitCode}`),
    },
    happyOutputMarker: `${marker}_OK`,
    failureOutputMarker: `${marker}_FAIL`,
    commandReceiptSignatures: {
      happy: ["node -e", "process.stdout.write", `${marker}_OK`],
      failure: [
        "node -e",
        "process.stderr.write",
        `${marker}_FAIL`,
        `process.exitCode = ${exitCode}`,
      ],
    },
  };
}

const BEHAVIORS: Record<QaNativeWorkspaceBehaviorId, QaNativeWorkspaceBehavior> = {
  bash: commandBehavior("bash", 7),
  edit: {
    id: "edit",
    nativeToolName: "apply_patch",
    providerToolName: "apply_patch",
    happyArgs: {
      input: [
        "*** Begin Patch",
        `*** Update File: ${EDIT_PATH}`,
        "@@",
        "-before edit",
        "+after edit",
        "*** End Patch",
        "",
      ].join("\n"),
    },
    failureArgs: {
      input: [
        "*** Begin Patch",
        `*** Update File: ${EDIT_DENIED_PATH}`,
        "@@",
        "-outside edit original",
        "+outside edit changed",
        "*** End Patch",
        "",
      ].join("\n"),
    },
    seedFiles: [{ path: EDIT_PATH, contents: "before edit\n" }],
    happyMutation: { path: EDIT_PATH, contents: "after edit\n" },
    failureSentinel: { path: EDIT_DENIED_PATH, contents: "outside edit original\n" },
  },
  exec: commandBehavior("exec", 8),
  "fs-read": {
    id: "fs-read",
    nativeToolName: "bash",
    providerToolName: "exec_command",
    happyArgs: {
      cmd: nodeCommand(
        "process.stdout.write(require('node:fs').readFileSync('runtime-tool-fixture-read.txt', 'utf8'))",
      ),
    },
    failureArgs: {
      cmd: nodeCommand(
        "require('node:fs').readFileSync('runtime-tool-fixture-read-missing.txt', 'utf8')",
      ),
    },
    happyOutputMarker: "RUNTIME_NATIVE_READ_OK",
    commandReceiptSignatures: {
      happy: ["readFileSync", "runtime-tool-fixture-read.txt"],
      failure: ["readFileSync", "runtime-tool-fixture-read-missing.txt"],
    },
    seedFiles: [{ path: "runtime-tool-fixture-read.txt", contents: "RUNTIME_NATIVE_READ_OK\n" }],
  },
  "fs-write": {
    id: "fs-write",
    nativeToolName: "bash",
    providerToolName: "exec_command",
    happyArgs: {
      cmd: nodeCommand(
        "require('node:fs').writeFileSync('runtime-tool-fixture-native-write.txt', 'runtime native write\\n')",
      ),
    },
    failureArgs: {
      cmd: nodeCommand(
        "require('node:fs').writeFileSync('../runtime-tool-fixture-native-write-denied.txt', 'must not change\\n')",
      ),
    },
    happyMutation: {
      path: "runtime-tool-fixture-native-write.txt",
      contents: "runtime native write\n",
    },
    failureSentinel: {
      path: "../runtime-tool-fixture-native-write-denied.txt",
      contents: "outside write original\n",
    },
    commandReceiptSignatures: {
      happy: ["writeFileSync", "runtime-tool-fixture-native-write.txt", "runtime native write"],
      failure: [
        "writeFileSync",
        "../runtime-tool-fixture-native-write-denied.txt",
        "must not change",
      ],
    },
  },
  grep: {
    id: "grep",
    nativeToolName: "bash",
    providerToolName: "exec_command",
    happyArgs: {
      cmd: nodeCommand(
        "const text = require('node:fs').readFileSync('runtime-tool-fixture-grep.txt', 'utf8'); const line = text.split(/\\r?\\n/u).find((value) => value.includes('RUNTIME_NATIVE_GREP_MATCH')); if (!line) process.exit(1); process.stdout.write(line + '\\n')",
      ),
    },
    failureArgs: {
      cmd: nodeCommand(
        "const text = require('node:fs').readFileSync('runtime-tool-fixture-grep.txt', 'utf8'); if (!text.includes('RUNTIME_NATIVE_GREP_MISSING')) process.exit(1)",
      ),
    },
    happyOutputMarker: "RUNTIME_NATIVE_GREP_MATCH",
    commandReceiptSignatures: {
      happy: [
        "readFileSync",
        "runtime-tool-fixture-grep.txt",
        ".find",
        "RUNTIME_NATIVE_GREP_MATCH",
      ],
      failure: [
        "readFileSync",
        "runtime-tool-fixture-grep.txt",
        ".includes",
        "RUNTIME_NATIVE_GREP_MISSING",
        "process.exit(1)",
      ],
    },
    seedFiles: [
      {
        path: "runtime-tool-fixture-grep.txt",
        contents: "alpha\nRUNTIME_NATIVE_GREP_MATCH\nomega\n",
      },
    ],
  },
};

export function readQaNativeWorkspaceBehaviorId(
  value: unknown,
): QaNativeWorkspaceBehaviorId | undefined {
  return typeof value === "string"
    ? QA_NATIVE_WORKSPACE_BEHAVIOR_IDS.find((candidate) => candidate === value)
    : undefined;
}

export function getQaNativeWorkspaceBehavior(
  id: QaNativeWorkspaceBehaviorId,
): QaNativeWorkspaceBehavior {
  return BEHAVIORS[id];
}

export function readQaNativeWorkspaceBehaviorFromPrompt(
  prompt: string,
): QaNativeWorkspaceBehavior | undefined {
  const id = /\bnative-workspace-behavior=([a-z-]+)\b/u.exec(prompt)?.[1];
  const behaviorId = readQaNativeWorkspaceBehaviorId(id);
  return behaviorId ? getQaNativeWorkspaceBehavior(behaviorId) : undefined;
}
