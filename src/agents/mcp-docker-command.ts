import path from "node:path";

type DockerCommand =
  | { kind: "other" }
  | { kind: "unsafe"; reason: string }
  | { kind: "docker"; command: string; args: string[]; hasName: boolean };

const dockerName = (command: string) => /^docker(?:\.exe)?$/iu.test(path.basename(command));

// This is a literal-command reader, not a shell evaluator. Expansions, redirects,
// pipelines and additional commands stay with the user's shell, without custody.
function literalShellWords(script: string): string[] | undefined {
  const words: string[] = [];
  let word = "";
  let started = false;
  let quote: "'" | '"' | undefined;
  for (let index = 0; index < script.length; index++) {
    const char = script[index]!;
    if (quote === "'") {
      if (char === quote) {
        quote = undefined;
      } else {
        word += char;
      }
    } else if (char === "\\") {
      const next = script[++index];
      if (next === undefined || next === "\n" || next === "\r") {
        return undefined;
      }
      if (quote === '"' && !/["\\$`]/u.test(next)) {
        word += "\\";
      }
      word += next;
      started = true;
    } else if (quote === '"') {
      if (char === quote) {
        quote = undefined;
      } else if (char === "$" || char === "`") {
        return undefined;
      } else {
        word += char;
      }
    } else if (char === "'" || char === '"') {
      quote = char;
      started = true;
    } else if (char === " " || char === "\t") {
      if (started) {
        words.push(word);
      }
      word = "";
      started = false;
    } else {
      if (/[\n\r$`;&|<>(){}*?[\]~#]/u.test(char)) {
        return undefined;
      }
      word += char;
      started = true;
    }
  }
  if (quote) {
    return undefined;
  }
  if (started) {
    words.push(word);
  }
  return words;
}

const booleanOptions = new Set([
  "--rm",
  "--init",
  "--interactive",
  "--read-only",
  "--privileged",
  "--oom-kill-disable",
  "--sig-proxy",
  "--publish-all",
]);
const valueOptions = new Set([
  "--name",
  "--label",
  "--env",
  "--env-file",
  "--volume",
  "--volumes-from",
  "--mount",
  "--workdir",
  "--user",
  "--group-add",
  "--network",
  "--network-alias",
  "--hostname",
  "--entrypoint",
  "--platform",
  "--memory",
  "--memory-swap",
  "--cpus",
  "--cpu-shares",
  "--cpuset-cpus",
  "--shm-size",
  "--ulimit",
  "--pids-limit",
  "--security-opt",
  "--cap-add",
  "--cap-drop",
  "--device",
  "--add-host",
  "--dns",
  "--dns-search",
  "--publish",
  "--expose",
  "--restart",
  "--pull",
  "--stop-signal",
  "--stop-timeout",
  "--runtime",
  "--tmpfs",
]);
const shortValues: Record<string, string> = {
  "-e": "--env",
  "-v": "--volume",
  "-w": "--workdir",
  "-u": "--user",
  "-l": "--label",
  "-p": "--publish",
  "-h": "--hostname",
  "-m": "--memory",
  "-c": "--cpu-shares",
};

/** Only known Docker run option boundaries may receive launch-owned flags. */
export function parseMcpDockerCommand(
  command: string,
  args: readonly string[] = [],
): DockerCommand {
  let executable = command;
  let argv = [...args];
  if (!dockerName(command)) {
    if (!/^(?:sh|bash|dash|zsh)$/u.test(path.basename(command))) {
      return { kind: "other" };
    }
    if (!args.some((arg) => /\bdocker\b/u.test(arg))) {
      return { kind: "other" };
    }
    const words =
      path.basename(command) === "sh" && args.length === 2 && args[0] === "-c"
        ? literalShellWords(args[1]!)
        : undefined;
    if (!words || words[0] !== "exec" || !dockerName(words[1] ?? "")) {
      return {
        kind: "unsafe",
        reason: "Docker shell wrapper is not a single literal exec command",
      };
    }
    executable = words[1]!;
    argv = words.slice(2);
  }
  const runIndex = argv[0] === "run" ? 0 : argv[0] === "container" && argv[1] === "run" ? 1 : -1;
  if (runIndex < 0) {
    return { kind: "unsafe", reason: "expected docker run without global options" };
  }
  // Normalize the supported container-run alias before injecting flags.
  argv = ["run", ...argv.slice(runIndex + 1)];
  let hasName = false;
  for (let index = 1; index < argv.length; index++) {
    const arg = argv[index]!;
    if (arg === "--") {
      if (argv[index + 1]) {
        return { kind: "docker", command: executable, args: argv, hasName };
      }
      break;
    }
    if (!arg.startsWith("-")) {
      return { kind: "docker", command: executable, args: argv, hasName };
    }
    if (arg === "-i" || arg === "-P") {
      continue;
    }
    const equals = arg.indexOf("=");
    const option = equals < 0 ? arg : arg.slice(0, equals);
    if (booleanOptions.has(option)) {
      if (equals >= 0 && !/^(?:true|false)$/u.test(arg.slice(equals + 1))) {
        break;
      }
      continue;
    }
    const canonical = shortValues[option] ?? option;
    if (!valueOptions.has(canonical)) {
      return { kind: "unsafe", reason: "unsupported or conflicting Docker run option" };
    }
    const value = equals < 0 ? argv[++index] : arg.slice(equals + 1);
    if (!value) {
      break;
    }
    if (canonical === "--label" && value.split("=", 1)[0]!.startsWith("openclaw.mcp.")) {
      return { kind: "unsafe", reason: "Docker run uses reserved openclaw.mcp labels" };
    }
    if (canonical === "--name") {
      hasName = true;
    }
  }
  return { kind: "unsafe", reason: "Docker run is missing an image or option value" };
}
