const childProcess = require("node:child_process");
const { fstatSync, lstatSync, realpathSync } = require("node:fs");
const { syncBuiltinESMExports } = require("node:module");
const { resolve } = require("node:path");
const { promisify } = require("node:util");

const lifetime = process.env.OPENCLAW_PR_LIFETIME_FILE;
const ancestorKey = "OPENCLAW_PR_LIFETIME_ANCESTORS";
const ancestors = JSON.parse(process.env[ancestorKey] || "[]");
const validate = (path, fd) => {
  const held = fstatSync(fd);
  const named = lstatSync(path);
  if (
    !held.isFile() ||
    !named.isFile() ||
    held.uid !== process.getuid() ||
    (held.mode & 0o7777) !== 0o600 ||
    held.nlink !== 1 ||
    held.dev !== named.dev ||
    held.ino !== named.ino ||
    realpathSync(path) !== resolve(path)
  ) {
    throw new Error("PR dependency lifetime descriptor differs");
  }
};
if (!Array.isArray(ancestors) || ancestors.some(({ fd }) => !Number.isInteger(fd) || fd < 10)) {
  throw new Error("Invalid PR ancestor lifetime descriptors");
}
for (const { path, fd } of ancestors) {
  validate(path, fd);
}
if (lifetime) {
  validate(lifetime, 7);
}
if (lifetime || ancestors.length) {
  const preload = `--require ${JSON.stringify(__filename)}`;
  const nodeOptions = (value = "") =>
    value.includes(preload) ? value : `${value} ${preload}`.trim();
  const prepared = Symbol("inherited PR lifetimes");
  const launches = new WeakMap();
  const inherit = (options) => {
    if (options[prepared]) {
      return options;
    }
    const env = { ...(options.env ?? process.env) };
    const mode = options.stdio ?? "pipe";
    const stdio = Array.isArray(mode) ? [...mode] : [mode, mode, mode];
    const replacement = env.OPENCLAW_PR_LIFETIME_FILE && env.OPENCLAW_PR_LIFETIME_FILE !== lifetime;
    const independent = env.HOME !== undefined && env.HOME !== process.env.HOME;
    const primary = replacement
      ? env.OPENCLAW_PR_LIFETIME_FILE
      : independent
        ? undefined
        : lifetime;
    const inherited = [...ancestors];
    const descriptors = new Map();
    if (lifetime && primary !== lifetime) {
      inherited.push({ path: lifetime, fd: 7 });
    }
    if (primary) {
      if (replacement) {
        if (!Number.isInteger(stdio[7])) {
          throw new Error("Child process FD7 conflicts with the PR dependency lifetime");
        }
        validate(primary, stdio[7]);
      } else {
        if (stdio[7] != null && stdio[7] !== "ignore" && stdio[7] !== 7) {
          throw new Error("Child process FD7 conflicts with the PR dependency lifetime");
        }
        while (stdio.length < 8) {
          stdio.push("ignore");
        }
        stdio[7] = 7;
      }
      descriptors.set(7, stdio[7]);
      env.OPENCLAW_PR_LIFETIME_FILE = primary;
    } else {
      delete env.OPENCLAW_PR_LIFETIME_FILE;
    }
    // A different cache namespace still belongs to its enclosing operation.
    // Keep those leases beyond FD9 (anchor authority), leaving FD7 free for it.
    const carried = inherited.map(({ path, fd }) => {
      let index = 10;
      while (stdio[index] != null && stdio[index] !== "ignore") {
        index++;
      }
      while (stdio.length <= index) {
        stdio.push("ignore");
      }
      stdio[index] = fd;
      descriptors.set(index, fd);
      return { path, fd: index };
    });
    if (carried.length) {
      env[ancestorKey] = JSON.stringify(carried);
    } else {
      delete env[ancestorKey];
    }
    env.NODE_OPTIONS = nodeOptions(env.NODE_OPTIONS);
    launches.set(env, descriptors);
    return { ...options, env, stdio, [prepared]: true };
  };
  // Node closes extra descriptors by default, even when the invoking shell
  // inherited them. execFile discards caller stdio, so async launches must bind
  // at Node's normalized ChildProcess boundary. Keep its original API semantics;
  // FD7 carries liveness only, never creator retirement authority.
  const spawn = childProcess.ChildProcess.prototype.spawn;
  childProcess.ChildProcess.prototype.spawn = function (options) {
    const descriptors = launches.get(options.env);
    if (descriptors) {
      const mode = options.stdio ?? "pipe";
      const stdio = Array.isArray(mode) ? [...mode] : [mode, mode, mode];
      for (const [fd, parentFd] of descriptors) {
        while (stdio.length <= fd) {
          stdio.push("ignore");
        }
        stdio[fd] = parentFd;
      }
      return spawn.call(this, { ...options, stdio });
    }
    const inherited = inherit(options);
    return spawn.call(this, {
      ...inherited,
      envPairs: Object.entries(inherited.env)
        .filter(([, value]) => value !== undefined)
        .map(([key, value]) => `${key}=${value}`),
    });
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
      const inherited = launches.has(options.env) ? options : inherit(options);
      const selected = name.endsWith("Sync") ? inherited : { ...options, env: inherited.env };
      if (typeof value === "function") {
        args.splice(index, 0, selected);
      } else {
        args[index] = selected;
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
