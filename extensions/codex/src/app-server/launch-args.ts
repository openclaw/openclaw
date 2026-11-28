import { createRequire } from "node:module";
import path from "node:path";

// Single-value root/app-server options from the pinned Codex CLI, shared_options,
// tui/cli, transport/auth, and code_mode_host. Values are never subcommands.
const CODEX_VALUE_OPTIONS = new Set([
  "-m",
  "--model",
  "--local-provider",
  "-p",
  "--profile",
  "-s",
  "--sandbox",
  "-a",
  "--ask-for-approval",
  "-C",
  "--cd",
  "--add-dir",
  "--remote",
  "--remote-auth-token-env",
  "-c",
  "--config",
  "--enable",
  "--disable",
  "--listen",
  "--sock",
  "--code-mode-host",
  "--ws-auth",
  "--ws-token-file",
  "--ws-token-sha256",
  "--ws-shared-secret-file",
  "--ws-issuer",
  "--ws-audience",
  "--ws-max-clock-skew-seconds",
]);

type CodexArg = { index: number; end: number; name: string; value?: string };

/** One tokenization owner for launch, turn policy, reviewer trust, and private turns. */
function readCodexArgs(args: readonly string[]): CodexArg[] {
  const tokens: CodexArg[] = [];
  let nativeSubcommand = false;
  let end = 0;
  for (const [index, arg] of args.entries()) {
    if (index < end) {
      continue;
    }
    end = index + 1;
    const attached = /^(--[^=]+)=([\s\S]*)$/u.exec(arg) ?? /^(-[cmpisaC])=?([\s\S]+)$/u.exec(arg);
    const name = attached?.[1] ?? arg;
    let value = attached?.[2];
    if (name === "-i" || name === "--image") {
      // Native image arguments consume multiple paths, even one named app-server.
      while (args[end]?.startsWith("-") === false) {
        end += 1;
      }
    } else if (!attached && CODEX_VALUE_OPTIONS.has(name)) {
      value = args[end];
      if (value !== undefined) {
        end += 1;
      }
    }
    tokens.push({ index, end, name, value });
    if (name === "app-server") {
      nativeSubcommand = true;
    }
    // A prefix -- may belong to a shell wrapper. After app-server it is native.
    if (name === "--" && nativeSubcommand) {
      break;
    }
  }
  return tokens;
}

/** Uses the native CLI configuration for status without starting its transport. */
export function buildCodexLoginStatusArgs(args: readonly string[]): string[] {
  const options = new Set(["-c", "--config", "-p", "--profile", "--enable", "--disable"]);
  const tokens = readCodexArgs(args);
  const subcommandIndex = tokens.findLast(({ name }) => name === "app-server")?.index ?? -1;
  const prefix = subcommandIndex < 0 ? [] : args.slice(0, subcommandIndex);
  const configArgs = tokens
    .filter(({ index, name }) => index > subcommandIndex && options.has(name))
    .flatMap(({ index, end }) => args.slice(index, end));
  return [...prefix, ...configArgs, "login", "status"];
}

export function readCodexAppServerConfigOptions(args: readonly string[]) {
  return readCodexArgs(args).filter(
    ({ name }) => name === "-c" || name === "--config" || name === "-p" || name === "--profile",
  );
}

const NODE_LAUNCH_VALUE_OPTIONS = new Set([
  "-r",
  "--require",
  "--import",
  "--loader",
  "--experimental-loader",
  "--max-old-space-size",
  "--max-semi-space-size",
  "--stack-size",
]);
const NODE_LAUNCH_FLAGS = new Set([
  "--enable-source-maps",
  "--no-warnings",
  "--trace-warnings",
  "--trace-uncaught",
  "--no-deprecation",
  "--trace-deprecation",
  "--experimental-strip-types",
  "--experimental-transform-types",
  "--no-experimental-strip-types",
  "--use-strict",
  "--expose-gc",
]);

function resolveNodeLauncherModule(value: string, option: string, cwd: string): string {
  if (path.isAbsolute(value)) {
    return value;
  }
  if (/^\.{1,2}[\\/]/u.test(value)) {
    return path.resolve(cwd, value);
  }
  if (option === "-r" || option === "--require") {
    // CommonJS package preloads resolve from the original launcher cwd, not
    // the private workspace. Resolution reads metadata without loading code.
    return createRequire(path.join(cwd, "openclaw-codex-launcher.cjs")).resolve(value);
  }
  if (/^(?:file|data|node):/u.test(value)) {
    return value;
  }
  throw new Error("Private Codex turns require an absolute or relative file path for ESM preloads");
}

/** Separates a supported launcher from native flags before a private turn sanitizes them. */
export function resolveCodexPrivateLauncher(params: {
  command: string;
  args: readonly string[];
  cwd: string;
}): { launcherArgs: string[]; nativeArgs: string[] } {
  const launcherArgs: string[] = [];
  let nativeArgs = [...params.args];
  const executable = params.command.split(/[\\/]/u).at(-1)?.toLowerCase();
  if (executable && ["node", "node.exe", "nodejs", "nodejs.exe"].includes(executable)) {
    let index = 0;
    while (params.args[index]?.startsWith("-")) {
      const raw = params.args[index]!;
      index += 1;
      if (raw === "--") {
        launcherArgs.push(raw);
        break;
      }
      const attached = /^(--[^=]+)=([\s\S]*)$/u.exec(raw) ?? /^(-r)([\s\S]+)$/u.exec(raw);
      const name = attached?.[1] ?? raw;
      const normalizedName = name.replaceAll("_", "-");
      if (NODE_LAUNCH_VALUE_OPTIONS.has(normalizedName)) {
        const value = attached?.[2] ?? params.args[index++];
        if (value === undefined || !value.trim()) {
          throw new Error("Private Codex turns received a Node launcher option without its value");
        }
        const moduleOption = [
          "-r",
          "--require",
          "--import",
          "--loader",
          "--experimental-loader",
        ].includes(normalizedName);
        if (attached && !moduleOption) {
          // V8 options such as --max-old-space-size require their attached value.
          launcherArgs.push(raw);
        } else {
          launcherArgs.push(
            name,
            moduleOption
              ? resolveNodeLauncherModule(value, normalizedName, path.resolve(params.cwd))
              : value,
          );
        }
      } else if (!attached && NODE_LAUNCH_FLAGS.has(name)) {
        launcherArgs.push(raw);
      } else {
        throw new Error(
          `Private Codex turns cannot isolate unsupported Node launcher option ${name}`,
        );
      }
    }
    const script = params.args[index];
    if (!script) {
      throw new Error("Private Codex turns require a Node wrapper script");
    }
    launcherArgs.push(path.resolve(params.cwd, script));
    nativeArgs = params.args.slice(index + 1);
    if (!readCodexArgs(nativeArgs).some(({ name }) => name === "app-server")) {
      throw new Error(
        "Private Codex turns require a native app-server command after the Node wrapper",
      );
    }
  }
  if (
    executable &&
    /^(?:(?:ba|da|z|fi)?sh|python(?:\d+(?:\.\d+)*)?|ruby|perl|cmd|powershell|pwsh)(?:\.exe)?$/u.test(
      executable,
    )
  ) {
    throw new Error(
      "Private Codex turns cannot isolate inline or interpreted wrappers; use a Node script or a directly executable wrapper",
    );
  }
  const tokens = readCodexArgs(nativeArgs);
  const serverIndex =
    tokens.findLast(({ name }) => name === "app-server")?.index ?? nativeArgs.length;
  if (
    tokens.some(
      ({ index, name }) => index < serverIndex && (!name.startsWith("-") || name === "--"),
    )
  ) {
    throw new Error(
      "Private Codex turns cannot isolate this launcher prefix; use a Node script or a directly executable wrapper",
    );
  }
  return { launcherArgs, nativeArgs };
}

/** The stdio proxy forwards to an external server; it does not own that runtime. */
export function isCodexAppServerProxyLaunch(args: readonly string[]): boolean {
  const tokens = readCodexArgs(args);
  const server = tokens.findLastIndex(({ name }) => name === "app-server");
  return (
    server >= 0 &&
    tokens.slice(server + 1).find(({ name }) => !name.startsWith("-"))?.name === "proxy"
  );
}

/** Keeps Codex overrides in one CLI scope without rewriting raw TOML or wrapper prefixes. */
export function normalizeCodexAppServerArgs(
  rawArgs: string[],
  enforcedOverride?: string,
): string[] {
  const tokens = readCodexArgs(rawArgs);
  const subcommandIndex = tokens.findLast(({ name }) => name === "app-server")?.index ?? -1;
  const prefix = subcommandIndex < 0 ? [...rawArgs] : rawArgs.slice(0, subcommandIndex);
  const suffix: string[] = [];
  if (subcommandIndex >= 0) {
    // clap replaces root global Append values when a suffix config flag exists.
    // Move only native suffix overrides, retaining their original order and bytes.
    for (const token of tokens) {
      if (token.index <= subcommandIndex) {
        continue;
      }
      if (token.name === "--") {
        suffix.push(...rawArgs.slice(token.index));
        break;
      }
      const target = token.name === "-c" || token.name === "--config" ? prefix : suffix;
      target.push(...rawArgs.slice(token.index, token.end));
    }
  }
  if (enforcedOverride && !(prefix.at(-2) === "-c" && prefix.at(-1) === enforcedOverride)) {
    prefix.push("-c", enforcedOverride);
  }
  const normalized = subcommandIndex < 0 ? prefix : [...prefix, "app-server", ...suffix];
  return normalized.length === rawArgs.length &&
    normalized.every((arg, index) => arg === rawArgs[index])
    ? rawArgs
    : normalized;
}
