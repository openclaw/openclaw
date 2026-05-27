export type NativeCommandSideEffect = "readOnlyDiagnostic" | "mutatingOrUnknown";

const READ_ONLY_COMMANDS = new Set([
  "cat",
  "date",
  "file",
  "grep",
  "head",
  "jq",
  "ls",
  "pwd",
  "rg",
  "stat",
  "tail",
  "wc",
]);

const READ_ONLY_GIT_COMMANDS = new Set([
  "diff",
  "grep",
  "log",
  "ls-files",
  "rev-parse",
  "show",
  "status",
]);

const SHELL_WRAPPER_PATTERN =
  /^(?:(?:\/usr\/bin\/env\s+)?(?:\/[^\s]+\/)?(?:bash|zsh|sh))\s+-lc\s+(.+)$/u;
const REDIRECTION_PATTERN = /(^|[^<>])(?:>>?|<>)($|\s|\S)/u;
const MUTATING_TOKEN_PATTERN =
  /(^|[\s|;&()])(?:apply_patch|chmod|chown|cp|install|kill|mkdir|mv|rm|rmdir|rsync|tee|touch|truncate|unlink)(?=$|[\s|;&()])/u;
const PACKAGE_MUTATION_PATTERN =
  /(^|[\s|;&()])(?:npm|pnpm|yarn)\s+(?:add|i|install|remove|uninstall|update)(?=$|[\s|;&()])/u;
const GIT_MUTATION_PATTERN =
  /(^|[\s|;&()])git(?:\s+-C\s+\S+)?\s+(?:add|am|apply|checkout|clean|commit|merge|mv|push|rebase|reset|restore|rm|switch|tag)(?=$|[\s|;&()])/u;
const CURL_MUTATION_PATTERN = /(^|[\s|;&()])curl\b[^\n]*(?:\s-X\s*(?:POST|PUT|PATCH|DELETE)\b)/iu;

function stripWrappingQuotes(value: string): string {
  if (value.length < 2) {
    return value;
  }
  const first = value[0];
  const last = value[value.length - 1];
  if ((first === `"` && last === `"`) || (first === "'" && last === "'")) {
    return value.slice(1, -1);
  }
  return value;
}

function unwrapShellCommand(command: string): string {
  let current = command.trim();
  for (let index = 0; index < 2; index += 1) {
    const match = SHELL_WRAPPER_PATTERN.exec(current);
    if (!match?.[1]) {
      return current;
    }
    current = stripWrappingQuotes(match[1].trim());
  }
  return current;
}

function hasShellControlChain(command: string): boolean {
  return /(?:^|[^|])(?:&&|\|\||;)(?:[^|]|$)/u.test(command);
}

function firstCommandToken(command: string): string | undefined {
  const firstSegment = command.split("|", 1)[0]?.trim();
  if (!firstSegment) {
    return undefined;
  }
  const firstToken = firstSegment.split(/\s+/u)[0]?.trim();
  if (!firstToken) {
    return undefined;
  }
  return firstToken.replace(/^.*\//u, "");
}

function gitSubcommand(command: string): string | undefined {
  const tokens = command.split(/\s+/u).filter(Boolean);
  if (tokens[0]?.replace(/^.*\//u, "") !== "git") {
    return undefined;
  }
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === "-C" || token === "-c") {
      index += 1;
      continue;
    }
    if (token?.startsWith("-")) {
      continue;
    }
    return token;
  }
  return undefined;
}

function isReadOnlyFind(command: string): boolean {
  return !/(^|\s)-(?:delete|exec|execdir)\b/u.test(command);
}

function isReadOnlySed(command: string): boolean {
  return !/(^|\s)-[A-Za-z]*i[A-Za-z]*(?:\s|$)/u.test(command);
}

function isReadOnlyGit(command: string): boolean {
  const subcommand = gitSubcommand(command);
  if (!subcommand) {
    return false;
  }
  if (subcommand === "branch") {
    return /\s--(?:list|show-current)(?:\s|$)/u.test(command);
  }
  return READ_ONLY_GIT_COMMANDS.has(subcommand);
}

export function classifyNativeCommandSideEffect(command: string): NativeCommandSideEffect {
  const unwrapped = unwrapShellCommand(command).trim();
  if (!unwrapped) {
    return "mutatingOrUnknown";
  }
  if (
    REDIRECTION_PATTERN.test(unwrapped) ||
    MUTATING_TOKEN_PATTERN.test(unwrapped) ||
    PACKAGE_MUTATION_PATTERN.test(unwrapped) ||
    GIT_MUTATION_PATTERN.test(unwrapped) ||
    CURL_MUTATION_PATTERN.test(unwrapped)
  ) {
    return "mutatingOrUnknown";
  }
  if (hasShellControlChain(unwrapped)) {
    return "mutatingOrUnknown";
  }
  const commandName = firstCommandToken(unwrapped);
  if (!commandName) {
    return "mutatingOrUnknown";
  }
  if (commandName === "find") {
    return isReadOnlyFind(unwrapped) ? "readOnlyDiagnostic" : "mutatingOrUnknown";
  }
  if (commandName === "sed") {
    return isReadOnlySed(unwrapped) ? "readOnlyDiagnostic" : "mutatingOrUnknown";
  }
  if (commandName === "git") {
    return isReadOnlyGit(unwrapped) ? "readOnlyDiagnostic" : "mutatingOrUnknown";
  }
  return READ_ONLY_COMMANDS.has(commandName) ? "readOnlyDiagnostic" : "mutatingOrUnknown";
}
