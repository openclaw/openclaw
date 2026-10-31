import path from "node:path";

// Matches Node's NODE_OPTIONS grammar: literal-space delimiters, double quotes,
// and backslash escapes only inside quotes.
export function parseNodeOptionsEnvVar(value) {
  const tokens = [];
  let token = "";
  let inQuotes = false;
  const nodeOptions = value ?? "";

  for (let index = 0; index < nodeOptions.length; index += 1) {
    let char = nodeOptions.charAt(index);
    if (char === "\\" && inQuotes) {
      index += 1;
      if (index >= nodeOptions.length) {
        return null;
      }
      char = nodeOptions.charAt(index);
    } else if (char === " " && !inQuotes) {
      if (token.length > 0) {
        tokens.push(token);
        token = "";
      }
      continue;
    } else if (char === '"') {
      inQuotes = !inQuotes;
      continue;
    }

    token += char;
  }

  if (inQuotes) {
    return null;
  }
  if (token.length > 0) {
    tokens.push(token);
  }
  return tokens;
}

/** Preloads can install module hooks and start an independent compiler/reaper. */
function isNodeStartupHook(arg) {
  return /^(?:--(?:import|require|(?:experimental-)?loader)(?:=|$)|-r)/u.test(
    arg.replaceAll("_", "-"),
  );
}

export function hasNodeStartupHooks(execArgv, nodeOptions) {
  const envArgs = parseNodeOptionsEnvVar(nodeOptions);
  return envArgs === null || [...execArgv, ...envArgs].some(isNodeStartupHook);
}

/** Dedicated process owners must not inherit the caller's instrumentation loaders. */
export function stripNodeStartupHooks(nodeOptions) {
  const args = parseNodeOptionsEnvVar(nodeOptions);
  if (args === null) {
    throw new Error("Invalid NODE_OPTIONS for process owner");
  }
  if (!args.some(isNodeStartupHook)) {
    return nodeOptions;
  }
  const retained = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (isNodeStartupHook(arg)) {
      if (arg === "-r" || (arg.startsWith("--") && !arg.includes("="))) {
        index += 1;
      }
    } else {
      retained.push('"' + arg.replaceAll("\\", "\\\\").replaceAll('"', '\\"') + '"');
    }
  }
  return retained.join(" ");
}

export function nodeRuntimePathEntries(value) {
  const windows = process.platform === "win32";
  return (value ?? "")
    .split(windows ? ";" : ":")
    .map((entry) => (windows ? entry.replace(/^"(.*)"$/, "$1") : entry))
    .filter(Boolean);
}

/** Keep lifecycle children on the explicitly selected runtime without changing npm config. */
export function withNodeRuntimePath(env, nodePath, platform = process.platform) {
  const paths = platform === "win32" ? path.win32 : path.posix;
  const keys = Object.keys(env)
    .toSorted()
    .filter((key) => (platform === "win32" ? key.toUpperCase() === "PATH" : key === "PATH"));
  const key = keys[0] ?? "PATH";
  const directory = paths.dirname(nodePath);
  const entries = (env[key] ? env[key].split(paths.delimiter) : []).filter(
    (entry) => entry !== directory,
  );
  const result = { ...env };
  for (const pathKey of keys.length ? keys : [key]) {
    result[pathKey] = [directory, ...entries].join(paths.delimiter);
  }
  return result;
}
