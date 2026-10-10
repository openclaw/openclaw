import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";
import { parseStrictPositiveInteger } from "openclaw/plugin-sdk/number-runtime";
import type { PluginCommandResult } from "openclaw/plugin-sdk/plugin-entry";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { CodexComputerUseConfig } from "./app-server/config.js";
import {
  buildCodexCommandPickerPresentation,
  type CodexCommandPickerButton,
} from "./command-presentation.js";

type ParsedBindArgs = {
  threadId?: string;
  cwd?: string;
  model?: string;
  provider?: string;
  help?: boolean;
};

type ParsedComputerUseArgs = {
  action: "status" | "install";
  overrides: Partial<CodexComputerUseConfig>;
  persistentIdentity: Partial<Pick<CodexComputerUseConfig, "pluginName" | "mcpServerName">>;
  help?: boolean;
};

const COMPUTER_USE_OPTIONS = [
  ["--source", "marketplaceSource"],
  ["--marketplace-source", "marketplaceSource"],
  ["--marketplace-path", "marketplacePath"],
  ["--path", "marketplacePath"],
  ["--marketplace", "marketplaceName"],
  ["--plugin", "pluginName"],
  ["--server", "mcpServerName"],
  ["--mcp-server", "mcpServerName"],
] as const;

type ParsedCodexCliSessionsArgs = {
  host?: string;
  filter: string;
  limit?: number;
  help?: boolean;
};

export type ParsedResumeArgs = {
  threadId?: string;
  host?: string;
  bindHere?: boolean;
  help?: boolean;
};

const CONNECTION_OPTIONS = {
  bind: new Map([
    ["--cwd", "cwd"],
    ["--model", "model"],
    ["--provider", "provider"],
    ["--model-provider", "provider"],
  ]),
  resume: new Map([
    ["--host", "host"],
    ["--node", "host"],
    ["--bind", "bind"],
  ]),
  sessions: new Map([
    ["--host", "host"],
    ["--node", "host"],
    ["--limit", "limit"],
  ]),
};

export function buildCodexSubcommandPickerReply(): PluginCommandResult {
  const verbs: CodexCommandPickerButton[] = [
    { label: "plugins", command: "/codex plugins menu" },
    { label: "permissions", command: "/codex permissions menu" },
    { label: "fast", command: "/codex fast menu" },
    { label: "computer-use", command: "/codex computer-use menu" },
    { label: "account", command: "/codex account" },
    { label: "refresh hosted apps", command: "/codex plugins refresh" },
    { label: "help", command: "/codex help" },
  ];
  const fallbackTextLines = [
    "Codex commands. Pick a category or type:",
    "",
    ...verbs.map((v, i) => `  ${i + 1}. ${v.command}`),
    "",
    "Tap 'help' (or type /codex help) for the full list of typeable verbs",
    "including threads, mcp, binding, detach, skills, resume, bind, steer,",
    "model, diagnostics, compact, review, computer-use.",
    "",
    "Top-level shortcuts cover everyday operations: /status, /fast, /help, /stop, /models.",
  ];
  return {
    text: fallbackTextLines.join("\n"),
    presentation: buildCodexCommandPickerPresentation(
      "Codex commands",
      "Pick a Codex subcommand:",
      verbs,
    ),
  };
}

export function buildCodexChoiceMenuReply(
  kind: "fast" | "permissions" | "computer-use",
): PluginCommandResult {
  const choices = {
    fast: ["on", "off", "status"],
    permissions: ["default", "yolo", "status"],
    "computer-use": ["status", "install"],
  }[kind];
  const title = `Codex ${kind === "fast" ? "fast mode" : kind}`;
  const argument = kind === "computer-use" ? "action" : "mode";
  const command = `/codex ${kind}`;
  const buttons: CodexCommandPickerButton[] = [
    ...choices.map((choice) => ({
      label: choice,
      command: `${command} ${choice}`,
    })),
    { label: "back", command: "/codex" },
  ];
  const fallbackTextLines = [
    `${title}. Pick one or type ${command} <${argument}>:`,
    "",
    ...choices.map((choice, index) => `  ${index + 1}. ${command} ${choice}`),
    "",
    ...(kind === "computer-use"
      ? [
          "Flag-driven invocations (--source, --marketplace-path, --marketplace) are not in the picker. Type '/codex computer-use' or read '/codex help' for the full surface.",
          "",
        ]
      : []),
    "Type '/codex' to go back to the main menu.",
  ];
  return {
    text: fallbackTextLines.join("\n"),
    presentation: buildCodexCommandPickerPresentation(
      title,
      `Pick a Codex ${kind} ${argument}:`,
      buttons,
    ),
  };
}

export function isMenuVerb(rest: readonly string[]): boolean {
  return rest.length === 1 && (rest[0] ?? "").trim().toLowerCase() === "menu";
}

export function splitArgs(value: string | undefined): string[] {
  const input = value ?? "";
  const args: string[] = [];
  let current = "";
  let quote: '"' | "'" | undefined;
  let escaping = false;
  let tokenStarted = false;
  for (const char of input) {
    if (escaping) {
      current += char;
      escaping = false;
      tokenStarted = true;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      escaping = true;
      tokenStarted = true;
      continue;
    }
    if (quote) {
      if (char === quote) {
        quote = undefined;
      } else {
        current += char;
      }
      tokenStarted = true;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      tokenStarted = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (tokenStarted) {
        args.push(current);
        current = "";
        tokenStarted = false;
      }
      continue;
    }
    current += char;
    tokenStarted = true;
  }
  if (escaping) {
    current += "\\";
  }
  if (tokenStarted) {
    args.push(current);
  }
  return args;
}

export function parseBindArgs(args: string[]): ParsedBindArgs {
  const { parsed, values } = parseConnectionArgs(args, "bind");
  return {
    ...parsed,
    cwd: normalizeOptionalString(values.get("cwd")),
    model: normalizeOptionalString(values.get("model")),
    provider: normalizeOptionalString(values.get("provider")),
  };
}

export function parseCodexCliSessionsArgs(args: string[]): ParsedCodexCliSessionsArgs {
  const { parsed, values, filter } = parseConnectionArgs(args, "sessions");
  return {
    ...parsed,
    host: normalizeOptionalString(values.get("host")),
    filter: filter.join(" ").trim(),
  };
}

export function parseResumeArgs(args: string[]): ParsedResumeArgs {
  const { parsed, values } = parseConnectionArgs(args, "resume");
  return {
    ...parsed,
    ...(values.has("bind") ? { bindHere: true } : {}),
    host: normalizeOptionalString(values.get("host")),
  };
}

function parseConnectionArgs(args: string[], kind: keyof typeof CONNECTION_OPTIONS) {
  const parsed: Pick<ParsedResumeArgs, "threadId" | "help"> & { limit?: number } = {};
  const values = new Map<string, string>();
  const filter: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = expectDefined(
      args[index],
      `current Codex ${kind === "sessions" ? "sessions" : "thread"} argument`,
    );
    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
      continue;
    }
    const option = CONNECTION_OPTIONS[kind].get(arg);
    if (option) {
      const value = readRequiredOptionValue(args, index);
      if (option === "limit") {
        const limit = parseStrictPositiveInteger(value);
        if (limit === undefined) {
          parsed.help = true;
          continue;
        }
        parsed.limit = limit;
        index += 1;
        continue;
      }
      if (!value || values.has(option) || (option === "bind" && value !== "here")) {
        parsed.help = true;
        continue;
      }
      values.set(option, value);
      index += 1;
      continue;
    }
    if (kind === "sessions" && !arg.startsWith("-")) {
      filter.push(arg);
      continue;
    }
    if (!arg.startsWith("-") && !parsed.threadId) {
      parsed.threadId = arg;
      continue;
    }
    parsed.help = true;
  }
  if (kind !== "sessions") {
    parsed.threadId = normalizeOptionalString(parsed.threadId);
  }
  return { parsed, values, filter };
}

export function parseComputerUseArgs(args: string[]): ParsedComputerUseArgs {
  const parsed: ParsedComputerUseArgs = {
    action: "status",
    overrides: {},
    persistentIdentity: {},
  };
  let sawAction = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
      continue;
    }
    if (arg === "status" || arg === "install") {
      if (sawAction) {
        parsed.help = true;
        continue;
      }
      sawAction = true;
      parsed.action = arg;
      continue;
    }
    const option = COMPUTER_USE_OPTIONS.find(([flag]) => flag === arg)?.[1];
    if (option) {
      const target: Partial<CodexComputerUseConfig> =
        option === "pluginName" || option === "mcpServerName"
          ? parsed.persistentIdentity
          : parsed.overrides;
      const value = readRequiredOptionValue(args, index);
      if (!value || target[option] !== undefined) {
        parsed.help = true;
        continue;
      }
      target[option] = value.trim();
      index += 1;
      continue;
    }
    parsed.help = true;
  }
  return parsed;
}

export function formatComputerUsePersistentIdentityMigration(
  parsed: ParsedComputerUseArgs,
): string {
  const configPrefix = "plugins.entries.codex.config.computerUse";
  const settings = (["pluginName", "mcpServerName"] as const).flatMap((key) => {
    const value = parsed.persistentIdentity[key];
    return value ? [`${configPrefix}.${key} = ${JSON.stringify(value)}`] : [];
  });
  const retryOptions = [
    ["marketplaceSource", "--source"],
    ["marketplacePath", "--marketplace-path"],
    ["marketplaceName", "--marketplace"],
  ] as const;
  const retryArgs = [
    `/codex computer-use ${parsed.action}`,
    ...retryOptions.flatMap(([key, flag]) => {
      const value = parsed.overrides[key];
      return value ? [`${flag} ${JSON.stringify(value)}`] : [];
    }),
  ];
  return [
    "One-off Computer Use plugin/server overrides are no longer supported.",
    `Set ${settings.join(" and ")} persistently, then rerun ${retryArgs.join(" ")}.`,
  ].join(" ");
}

function readRequiredOptionValue(args: string[], index: number): string | undefined {
  const value = args[index + 1];
  const normalized = value?.trim();
  if (!normalized || normalized.startsWith("-")) {
    return undefined;
  }
  return value;
}
