/**
 * Keep these schemas provider-friendly: flat fields, string enums, and explicit
 * descriptions that match runtime validation.
 */
import { Type } from "typebox";
import { isRequestedExecTargetAllowed } from "./bash-tools.exec-target.js";
import type { ExecToolDefaults } from "./bash-tools.exec-types.js";
import { createCachedToolSchema } from "./schema/cached-schema.js";
import { executionTitleSchema, optionalStringEnum } from "./schema/typebox.js";

const EXEC_TOOL_HOST_VALUES = ["auto", "sandbox", "gateway", "node"] as const;
const PROCESS_TOOL_ACTIONS = [
  "list",
  "poll",
  "log",
  "write",
  "send-keys",
  "submit",
  "paste",
  "kill",
  "clear",
  "remove",
] as const;

export const execSchema = Type.Object({
  title: executionTitleSchema(),
  command: Type.String({ description: "Shell command." }),
  saveOutput: Type.Optional(
    Type.Boolean({
      description:
        "Save up to 2 MiB of output as a private workspace file; gateway only. User removes it.",
    }),
  ),
  workdir: Type.Optional(
    Type.String({
      description: "Omit/empty string: default; whitespace-only invalid.",
    }),
  ),
  env: Type.Optional(
    Type.Record(Type.String(), Type.String(), {
      description: "Literal overrides; no expansion. Omit to inherit.",
    }),
  ),
  yieldMs: Type.Optional(
    Type.Number({
      description: "Milliseconds before returning an ordinary-command handle; default 10000.",
    }),
  ),
  awaitResults: Type.Optional(
    Type.Boolean({
      description:
        "Result required to finish the task; wait for terminal collection. Not for detached servers.",
    }),
  ),
  background: Type.Optional(
    Type.Boolean({
      description:
        "Start an independent service now; survives request Stop. Use yieldMs for ordinary work. timeoutSeconds applies.",
    }),
  ),
  timeoutSeconds: Type.Optional(
    Type.Number({
      description: "Process lifetime in seconds; 0 disables.",
    }),
  ),
  pty: Type.Optional(
    Type.Boolean({
      description: "PTY for TTY-required CLIs/coding agents.",
    }),
  ),
  elevated: Type.Optional(
    Type.Boolean({
      description: "Host elevation if allowed.",
    }),
  ),
  host: optionalStringEnum(EXEC_TOOL_HOST_VALUES, {
    description: "Omit: named node or configured host. auto: configured host.",
  }),
  ask: Type.Optional(
    Type.String({
      description:
        "Requests stricter approvals under tools.exec.mode and host policy; channel-origin calls cannot override host ask=off.",
    }),
  ),
  node: Type.Optional(
    Type.String({
      description: "Node id/name; implies host=node if host is omitted. Other hosts conflict.",
    }),
  ),
});

/** Capture host capabilities once; direct tools and catalog hints share this schema. */
export function createExecSchema(
  defaults?: Pick<ExecToolDefaults, "host" | "sandbox" | "sandboxRequired">,
) {
  return execSchemas(defaults).standard;
}

/** Exec parameters when no process-control continuation is authorized. */
export function createExecCompletionSchema(
  defaults?: Pick<ExecToolDefaults, "host" | "sandbox" | "sandboxRequired">,
) {
  return execSchemas(defaults).completion;
}

const execSchemas = createCachedToolSchema({
  key: (defaults?: Pick<ExecToolDefaults, "host" | "sandbox" | "sandboxRequired">) =>
    `${defaults?.sandboxRequired ? "sandbox" : (defaults?.host ?? "auto")}:${Boolean(defaults?.sandbox)}`,
  build: buildExecSchemas,
});

function buildExecSchemas(
  defaults?: Pick<ExecToolDefaults, "host" | "sandbox" | "sandboxRequired">,
) {
  const sandboxAvailable = Boolean(defaults?.sandbox);
  const configuredTarget = defaults?.sandboxRequired ? "sandbox" : (defaults?.host ?? "auto");
  const hosts = EXEC_TOOL_HOST_VALUES.filter(
    (requestedTarget) =>
      requestedTarget === "auto" ||
      ((requestedTarget !== "sandbox" || sandboxAvailable) &&
        isRequestedExecTargetAllowed({ configuredTarget, requestedTarget, sandboxAvailable })),
  );
  const standard = Type.Object({
    ...execSchema.properties,
    host: optionalStringEnum(hosts, {
      description: `Omit: named node or configured host (${configuredTarget === "auto" ? (sandboxAvailable ? "sandbox" : "gateway") : configuredTarget}). auto: configured host.`,
    }),
  });
  return { standard, completion: Type.Omit(standard, ["yieldMs", "background"]) };
}

/** Parameters exposed by node-only exec surfaces. */
export const nodeExecSchema = Type.Object({
  title: execSchema.properties.title,
  command: execSchema.properties.command,
  workdir: execSchema.properties.workdir,
  env: execSchema.properties.env,
  timeoutSeconds: execSchema.properties.timeoutSeconds,
  host: optionalStringEnum(["node"] as const, {
    description: "Exec target. Only node is available on this tool surface.",
  }),
  node: execSchema.properties.node,
});

export const processSchema = Type.Object({
  action: Type.String({
    enum: [...PROCESS_TOOL_ACTIONS],
    description: "Process action (list|poll|log|write|send-keys|submit|paste|kill|clear|remove)",
  }),
  sessionId: Type.Optional(Type.String({ description: "Required for every action except list." })),
  data: Type.Optional(Type.String({ description: "Data to write for write" })),
  keys: Type.Optional(
    Type.Array(Type.String(), { description: "Key tokens to send for send-keys" }),
  ),
  hex: Type.Optional(Type.Array(Type.String(), { description: "Hex bytes to send for send-keys" })),
  literal: Type.Optional(Type.String({ description: "Literal string for send-keys" })),
  text: Type.Optional(Type.String({ description: "Text to paste for paste" })),
  bracketed: Type.Optional(Type.Boolean({ description: "Wrap paste in bracketed mode" })),
  eof: Type.Optional(Type.Boolean({ description: "Close stdin after write" })),
  offset: Type.Optional(Type.Number({ description: "Log offset" })),
  limit: Type.Optional(Type.Number({ description: "Log length" })),
  timeout: Type.Optional(
    Type.Number({
      description:
        "For poll: wait up to this many milliseconds before returning; max 30000 ms, higher values are clamped to 30000",
      minimum: 0,
    }),
  ),
});
