import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { CliBackendPlugin } from "openclaw/plugin-sdk/cli-backend";
import {
  CLI_FRESH_WATCHDOG_DEFAULTS,
  CLI_RESUME_WATCHDOG_DEFAULTS,
} from "openclaw/plugin-sdk/cli-backend";
import { normalizeProviderId } from "openclaw/plugin-sdk/provider-model-shared";
import {
  CLAUDE_CLI_BACKEND_ID,
  CLAUDE_CLI_INTERACTIVE_BACKEND_ID,
  CLAUDE_CLI_MODEL_ALIASES,
  CLAUDE_CLI_SESSION_ID_FIELDS,
} from "./cli-constants.js";
import {
  CLAUDE_CLI_CLEAR_ENV,
  normalizeClaudeBackendConfig,
  resolveClaudeCliExecutionArgs,
} from "./cli-shared.js";

// Args from claude-cli's `-p` (headless) dialect that don't apply when claude
// runs interactively. Stripped from inherited user overrides so users can keep
// a single `agents.defaults.cliBackends.claude-cli` block and still get sane
// behaviour on the interactive variant.
const P_MODE_FLAGS_NO_VALUE = new Set([
  "-p",
  "--print",
  "--include-partial-messages",
  "--fork-session",
]);
const P_MODE_FLAGS_WITH_VALUE = new Set(["--output-format"]);

function stripPModeArgs(args: readonly string[]): string[] {
  const result: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? "";
    if (P_MODE_FLAGS_NO_VALUE.has(arg)) {
      continue;
    }
    if (P_MODE_FLAGS_WITH_VALUE.has(arg)) {
      i += 1; // skip the value too
      continue;
    }
    let skipped = false;
    for (const flag of P_MODE_FLAGS_WITH_VALUE) {
      if (arg.startsWith(`${flag}=`)) {
        skipped = true;
        break;
      }
    }
    if (skipped) {
      continue;
    }
    result.push(arg);
  }
  return result;
}

// Filter inherited claude-cli args for use here: drop -p-mode flags and prepend
// WRAPPER_PATH so `bun` always receives the wrapper script as its first arg
// (the merge REPLACES args wholesale, so the inherited list must be complete).
function makeInheritFilter(wrapperPath: string): (args: readonly string[]) => string[] {
  return (args) => [wrapperPath, ...stripPModeArgs(args)];
}

// Resolve wrapper path relative to this module at runtime. Must tolerate two
// layouts:
//   (a) source / non-hoisted build — this file is a sibling of interactive-proxy/
//       so ./interactive-proxy/wrapper.{js,ts} resolves correctly off
//       import.meta.url.
//   (b) hoisted dist — OpenClaw's bundler (rollup) lifts this module into a
//       shared chunk at dist/<chunk>-<hash>.js. import.meta.url then points at
//       that chunk's location (dist/), NOT the original source location
//       (dist/extensions/anthropic/). The static-asset copier still writes the
//       interactive-proxy files to dist/extensions/anthropic/interactive-proxy/,
//       so we have to try that path explicitly.
// Probe both layouts in order, then fail loudly with the candidates we tried
// rather than handing Bun a path that doesn't exist.
function resolveWrapperPath(): string {
  const selfUrl = import.meta.url;
  const candidates = [
    fileURLToPath(new URL("./interactive-proxy/wrapper.js", selfUrl)),
    fileURLToPath(new URL("./interactive-proxy/wrapper.ts", selfUrl)),
    fileURLToPath(new URL("./extensions/anthropic/interactive-proxy/wrapper.js", selfUrl)),
    fileURLToPath(new URL("./extensions/anthropic/interactive-proxy/wrapper.ts", selfUrl)),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error(
    `[anthropic-interactive] interactive-proxy/wrapper not found relative to ${fileURLToPath(selfUrl)}. ` +
      `Tried: ${candidates.join(", ")}`,
  );
}

const WRAPPER_PATH = resolveWrapperPath();

export function buildAnthropicInteractiveCliBackend(): CliBackendPlugin {
  return {
    id: CLAUDE_CLI_INTERACTIVE_BACKEND_ID,
    // Same canonical provider as the plain claude-cli backend: this is an
    // anthropic runtime alias (it executes Claude models, just via the local
    // proxy). Without it the backend is treated as standalone and is invisible
    // to the canonical `anthropic` runtime-alias and auth-profile selection
    // paths that current main requires.
    modelProvider: "anthropic",
    liveTest: {
      defaultModelRef: `${CLAUDE_CLI_INTERACTIVE_BACKEND_ID}/claude-opus-4-7`,
      defaultImageProbe: false,
      defaultMcpProbe: true,
      docker: {
        npmPackage: "@anthropic-ai/claude-code",
        binaryName: "claude",
      },
    },
    bundleMcp: true,
    bundleMcpMode: "claude-config-file",
    nativeToolMode: "always-on",
    config: {
      // Wrapper is spawned by Bun; it starts the MITM proxy, then runs claude
      // in interactive (subscription) mode with HTTPS_PROXY + NODE_EXTRA_CA_CERTS
      // so that thinking_delta and text_delta events flow through the proxy for
      // real-time capture. No -p flag — subscription billing path only.
      command: "bun",
      args: [
        WRAPPER_PATH,
        "--verbose",
        "--setting-sources",
        "user",
        "--allowedTools",
        "mcp__openclaw__*",
      ],
      resumeArgs: [
        WRAPPER_PATH,
        "--verbose",
        "--setting-sources",
        "user",
        "--allowedTools",
        "mcp__openclaw__*",
        "--resume",
        "{sessionId}",
      ],
      output: "jsonl",
      jsonlDialect: "claude-stream-json",
      input: "arg",
      modelArg: "--model",
      modelAliases: CLAUDE_CLI_MODEL_ALIASES,
      imageArg: "@",
      imagePathScope: "workspace",
      sessionArg: "--session-id",
      sessionMode: "always",
      reseedFromRawTranscriptWhenUncompacted: true,
      sessionIdFields: [...CLAUDE_CLI_SESSION_ID_FIELDS],
      systemPromptFileArg: "--append-system-prompt-file",
      systemPromptMode: "append",
      systemPromptWhen: "first",
      clearEnv: [...CLAUDE_CLI_CLEAR_ENV],
      reliability: {
        watchdog: {
          fresh: { ...CLI_FRESH_WATCHDOG_DEFAULTS },
          resume: { ...CLI_RESUME_WATCHDOG_DEFAULTS },
        },
      },
      // Match claude-cli's serialization semantics: queue runs that share
      // the same Claude session / workspace so two resumes can't race on
      // one session transcript. The framework keys by session id, so
      // independent sessions still run concurrently. An earlier revision
      // set this to `false` to dodge a preferred-port race between two
      // wrappers starting simultaneously, but mitm-server now binds on
      // port 0 (both TLS and CONNECT servers) so the OS picks per-instance
      // and concurrent proxies no longer collide.
      serialize: true,
    },
    // After mergeBackendConfig spreads the inherited claude-cli override on top
    // of our base, `merged.command` becomes the inherited claude binary path
    // (e.g. an absolute path to claude.exe). We need:
    //   1. `command` forced back to "bun" so the wrapper actually runs as a
    //      script (otherwise claude.exe would be spawned with WRAPPER_PATH as
    //      a positional prompt and the MITM proxy never starts).
    //   2. The inherited claude binary path stashed on env so wrapper.ts can
    //      spawn that exact binary, bypassing PATH lookups that can shadow it
    //      with a different claude install (e.g. winget vs npm on Windows).
    normalizeConfig: (merged, context) => {
      const inheritedClaudeBinary = merged.command;
      const normalized = normalizeClaudeBackendConfig(merged, context);
      const env: Record<string, string> = { ...normalized.env };
      // Classify the merged command by checking inheritance provenance
      // directly: compare against the user-configured claude-cli backend's
      // command in OpenClawConfig. Match → inherited claude binary. Differ
      // → direct override on this backend (operator-provided Bun path).
      // This works for any wrapper-script name (claude-wrapper.sh, custom
      // symlinks, etc.) instead of relying on a basename allow-list that
      // missed configured-wrapper cases.
      // `resolveCliBackendConfig` inherits sibling backend config by normalized
      // id, so an operator who has only `agents.defaults.cliBackends.anthropic-cli`
      // configured (the legacy alias) still gets that command merged in here.
      // We must therefore look up the sibling command with the same normalization
      // (anthropic-cli → claude-cli) rather than the literal "claude-cli" key, or
      // the inherited claude binary gets misclassified as a direct Bun override
      // and the MITM proxy never starts. Closes ClawSweeper P2a on PR #81851.
      const inheritedClaudeCliCommand = (() => {
        const backends = context?.config?.agents?.defaults?.cliBackends ?? {};
        for (const [key, entry] of Object.entries(backends)) {
          if (normalizeProviderId(key) === CLAUDE_CLI_BACKEND_ID) {
            return entry?.command;
          }
        }
        return undefined;
      })();
      const isInheritedFromClaudeCli =
        Boolean(inheritedClaudeBinary) &&
        inheritedClaudeBinary !== "bun" &&
        typeof inheritedClaudeCliCommand === "string" &&
        inheritedClaudeBinary === inheritedClaudeCliCommand;
      const isDirectBunOverride =
        Boolean(inheritedClaudeBinary) &&
        inheritedClaudeBinary !== "bun" &&
        !isInheritedFromClaudeCli;
      if (isInheritedFromClaudeCli) {
        env.OPENCLAW_INTERACTIVE_CLAUDE_BINARY = inheritedClaudeBinary;
      }
      const resolvedCommand = isDirectBunOverride ? inheritedClaudeBinary : "bun";
      const ensureAllowedTools = (argList: string[] | undefined): string[] | undefined => {
        if (!argList) {
          return argList;
        }
        const arr = [...argList];
        if (!arr.includes("mcp__openclaw__*")) {
          arr.push("--allowedTools", "mcp__openclaw__*");
        }
        return arr;
      };
      return {
        ...normalized,
        command: resolvedCommand,
        input: "arg",
        // Platform-aware argv cap. Interactive claude has no stdin/file
        // prompt path (TUI mode reads stdin as live keystrokes, not as the
        // initial turn prompt) — the positional argv is the only delivery
        // mechanism. The cap therefore reflects what the OS will actually
        // accept on `spawn()`:
        //   • Windows: CreateProcess hard limit is 32767 chars across the
        //     entire command line. Reserve ~2700 chars for wrapper.ts path
        //     + the ~10 other claude flags + their values → 30000.
        //   • Unix:   ARG_MAX is typically 2 MB on Linux and 256 KB on
        //     macOS. 200000 keeps a comfortable margin without making
        //     every gateway run buffer arbitrary user content.
        // Prompts beyond the cap spill to stdin under OpenClaw's framework,
        // which the wrapper detects at startup and surfaces as a clear
        // failover-triggering error rather than hanging the turn.
        maxPromptArgChars: process.platform === "win32" ? 30000 : 200000,
        systemPromptMode: "append",
        systemPromptWhen: "first",
        args: ensureAllowedTools(normalized.args),
        resumeArgs: ensureAllowedTools(normalized.resumeArgs),
        env,
      };
    },
    resolveExecutionArgs: resolveClaudeCliExecutionArgs,
    inheritUserConfigFrom: {
      backendId: CLAUDE_CLI_BACKEND_ID,
      filterArgs: makeInheritFilter(WRAPPER_PATH),
    },
  };
}
