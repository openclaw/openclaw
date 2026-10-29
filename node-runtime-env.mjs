import path from "node:path";

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
  const keys = Object.keys(env).filter((key) =>
    platform === "win32" ? key.toUpperCase() === "PATH" : key === "PATH",
  );
  // Select the same first lexical alias without requiring newer Array methods.
  const key = keys.length ? keys.reduce((first, entry) => (entry < first ? entry : first)) : "PATH";
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
