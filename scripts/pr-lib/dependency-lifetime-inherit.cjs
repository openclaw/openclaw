const childProcess = require("node:child_process");
const { fstatSync, lstatSync, realpathSync } = require("node:fs");
const { syncBuiltinESMExports } = require("node:module");
const { resolve } = require("node:path");
const { promisify } = require("node:util");

const lifetime = process.env.OPENCLAW_PR_LIFETIME_FILE;
if (lifetime) {
  const held = fstatSync(7);
  const named = lstatSync(lifetime);
  if (
    !held.isFile() ||
    !named.isFile() ||
    held.uid !== process.getuid() ||
    (held.mode & 0o7777) !== 0o600 ||
    held.nlink !== 1 ||
    held.dev !== named.dev ||
    held.ino !== named.ino ||
    realpathSync(lifetime) !== resolve(lifetime)
  ) {
    throw new Error("PR dependency lifetime descriptor differs");
  }
  const preload = `--require ${JSON.stringify(__filename)}`;
  const nodeOptions = (value = "") =>
    value.includes(preload) ? value : `${value} ${preload}`.trim();
  /** @param {import("node:child_process").StdioOptions} [mode] */
  const inheritStdio = (mode = "pipe") => {
    const stdio = Array.isArray(mode) ? [...mode] : [mode, mode, mode];
    if (stdio[7] != null && stdio[7] !== "ignore" && stdio[7] !== 7) {
      throw new Error("Child process FD7 conflicts with the PR dependency lifetime");
    }
    while (stdio.length < 8) {
      stdio.push("ignore");
    }
    stdio[7] = 7;
    return stdio;
  };
  // Node closes extra descriptors by default, even when the invoking shell
  // inherited them. execFile discards caller stdio, so async launches must bind
  // at Node's normalized ChildProcess boundary. Keep its original API semantics;
  // FD7 carries liveness only, never creator retirement authority.
  const spawn = childProcess.ChildProcess.prototype.spawn;
  childProcess.ChildProcess.prototype.spawn = function (options) {
    return spawn.call(this, { ...options, stdio: inheritStdio(options.stdio) });
  };
  for (const name of [
    "spawn",
    "spawnSync",
    "exec",
    "execSync",
    "execFile",
    "execFileSync",
    "fork",
  ]) {
    const original = childProcess[name];
    const prepare = (args) => {
      const optionalArgs = name !== "exec" && name !== "execSync";
      const index =
        optionalArgs &&
        (Array.isArray(args[1]) ||
          (args[1] == null && args.length > 2 && typeof args[2] !== "function"))
          ? 2
          : 1;
      const value = args[index];
      const options = typeof value === "function" || value == null ? {} : value;
      if (typeof options !== "object") {
        throw new TypeError("Child process options must be an object");
      }
      const env = options.env ?? process.env;
      const inherited = {
        ...options,
        ...(name.endsWith("Sync") ? { stdio: inheritStdio(options.stdio) } : {}),
        env: {
          ...env,
          OPENCLAW_PR_LIFETIME_FILE: lifetime,
          NODE_OPTIONS: nodeOptions(env.NODE_OPTIONS),
        },
      };
      if (typeof value === "function") {
        args.splice(index, 0, inherited);
      } else {
        args[index] = inherited;
      }
      return args;
    };
    const wrapped = (...args) => original(...prepare(args));
    if (original[promisify.custom]) {
      wrapped[promisify.custom] = (...args) => original[promisify.custom](...prepare(args));
    }
    childProcess[name] = wrapped;
  }
  syncBuiltinESMExports();
}
