import { Type } from "@sinclair/typebox";

export const execSchema = Type.Object({
  command: Type.String({ description: "Shell command to execute" }),
  workdir: Type.Optional(Type.String({ description: "Working directory (defaults to cwd)" })),
  env: Type.Optional(Type.Record(Type.String(), Type.String())),
  yieldMs: Type.Optional(
    Type.Number({
      description: "Milliseconds to wait before backgrounding (default 10000)",
    }),
  ),
  background: Type.Optional(Type.Boolean({ description: "Run in background immediately" })),
  timeout: Type.Optional(
    Type.Number({
      description: "Timeout in seconds (optional, kills process on expiry)",
    }),
  ),
  pty: Type.Optional(
    Type.Boolean({
      description:
        "Run in a pseudo-terminal (PTY) when available (TTY-required CLIs, coding agents)",
    }),
  ),
  elevated: Type.Optional(
    Type.Boolean({
      description: "Run on the host with elevated permissions (if allowed)",
    }),
  ),
  host: Type.Optional(
    Type.String({
      description: "Exec host/target (auto|sandbox|gateway|node).",
    }),
  ),
  // NOTE: `security` and `ask` are intentionally NOT model-visible.
  // Exec security tier and ask-mode are trust-boundary decisions that must be
  // resolved from agent config only (agents[].tools.exec.security /
  // top-level tools.exec.security / security-v2.defaultSecurity). Allowing the
  // model to pick a per-call `security`/`ask` value let models with a strong
  // "allowlist"-prior silently downgrade `configured="full"` to
  // `effective="allowlist"` and trigger `exec denied: allowlist miss` on
  // legitimate commands. See GH issue / linked PR for the smoking-gun case.
  node: Type.Optional(
    Type.String({
      description: "Node id/name for host=node.",
    }),
  ),
});

export const processSchema = Type.Object({
  action: Type.String({ description: "Process action" }),
  sessionId: Type.Optional(Type.String({ description: "Session id for actions other than list" })),
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
      description: "For poll: wait up to this many milliseconds before returning",
      minimum: 0,
    }),
  ),
});
