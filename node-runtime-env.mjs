import path from "node:path";

/** Keep lifecycle children on the explicitly selected runtime without changing npm config. */
export function withNodeRuntimePath(env, nodePath, platform = process.platform) {
  const paths = platform === "win32" ? path.win32 : path.posix;
  const keys = Object.keys(env)
    .sort()
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
