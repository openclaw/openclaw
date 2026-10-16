import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/** @typedef {import("node:child_process").ExecFileSyncOptions} ExecFileSyncOptions */
/** @typedef {import("node:child_process").ExecFileSyncOptionsWithBufferEncoding} ExecFileSyncOptionsWithBufferEncoding */
/** @typedef {import("node:child_process").ExecFileSyncOptionsWithStringEncoding} ExecFileSyncOptionsWithStringEncoding */
/**
 * @typedef {(
 *   command: string,
 *   args: readonly string[],
 *   options: ExecFileSyncOptions,
 * ) => string | Uint8Array<ArrayBuffer>} ExecGhReadImpl
 */

const PLAIN_GH_MAX_BUFFER_BYTES = 32 * 1024 * 1024;
const ASYNC_GH_DRAIN_GRACE_MS = 1_000;
let activeAsyncGh = 0;
const pendingAsyncGh = [];
let asyncGhRefusal;

function refuseFurtherAsyncGh(cause) {
  asyncGhRefusal ??= Object.assign(
    new Error("Earlier GitHub child output did not drain; refusing further asynchronous reads", {
      cause,
    }),
    { code: "OPENCLAW_GH_UNJOINED" },
  );
  for (const pending of pendingAsyncGh.splice(0)) {
    pending.reject(asyncGhRefusal);
  }
}

// Share the process-wide budget across protected-writer and cache-aware reads.
async function runGhAsync(file, args, options) {
  if (asyncGhRefusal) {
    throw asyncGhRefusal;
  }
  if (activeAsyncGh >= 4) {
    await new Promise((resolve, reject) => {
      pendingAsyncGh.push({ resolve, reject });
    });
  } else {
    activeAsyncGh += 1;
  }
  try {
    if (asyncGhRefusal) {
      throw asyncGhRefusal;
    }
    return await new Promise((resolve, reject) => {
      const child = spawn(file, args, {
        ...options,
        stdio: options.stdio ?? ["ignore", "pipe", "pipe"],
      });
      const output = { stdout: [], stderr: [] };
      const lengths = { stdout: 0, stderr: 0 };
      const maxBuffer = options.maxBuffer ?? PLAIN_GH_MAX_BUFFER_BYTES;
      /** @type {Error | undefined} */
      let failure;
      let timeout;
      let drainTimeout;
      let stopping = false;
      const stop = () => {
        if (stopping) {
          return;
        }
        stopping = true;
        clearTimeout(timeout);
        // Give a terminated leader's output time to reach EOF on a slow host.
        // Forced capture closure cannot prove inherited notifier/input lifetime.
        drainTimeout = setTimeout(() => {
          const outputs = [child.stdout, child.stderr].filter(Boolean);
          if (outputs.some((pipe) => !pipe.readableEnded && !pipe.destroyed)) {
            Object.assign(failure, { processTreeState: "indeterminate" });
            refuseFurtherAsyncGh(failure);
          }
          for (const pipe of outputs) {
            pipe.destroy();
          }
        }, ASYNC_GH_DRAIN_GRACE_MS);
        child.kill(options.killSignal ?? "SIGTERM");
      };
      for (const stream of ["stdout", "stderr"]) {
        child[stream]?.on("data", (bytes) => {
          const chunk = Buffer.from(bytes);
          lengths[stream] += chunk.length;
          if (lengths[stream] > maxBuffer && !failure) {
            failure = Object.assign(new Error(`${stream} maxBuffer length exceeded`), {
              code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
            });
            stop();
          }
          if (lengths[stream] <= maxBuffer) {
            output[stream].push(chunk);
          }
        });
      }
      child.on("error", (error) => {
        failure ??= error;
      });
      // Settle only after streams and the child close, including failure paths.
      child.on("close", (code, signal) => {
        clearTimeout(timeout);
        clearTimeout(drainTimeout);
        const decode = (chunks) => {
          const bytes = Buffer.concat(chunks);
          return options.encoding && options.encoding !== "buffer"
            ? bytes.toString(options.encoding)
            : bytes;
        };
        const stdout = decode(output.stdout),
          stderr = decode(output.stderr);
        if (failure || code !== 0) {
          const error = failure ?? new Error(`Command failed: ${file}\n${String(stderr)}`);
          Object.assign(error, {
            ...(failure ? {} : { code }),
            status: typeof code === "number" ? code : 1,
            signal,
            killed: child.killed ?? false,
            stdout,
            stderr,
            output: [null, stdout, stderr],
          });
          reject(error);
        } else {
          resolve(stdout);
        }
      });
      // spawn's timer ends at leader exit; a wrapper's descendants can retain
      // its output longer. The read deadline also covers that drainage.
      if (options.timeout > 0) {
        timeout = setTimeout(() => {
          failure ??= Object.assign(
            new Error(`GitHub child timed out after ${options.timeout}ms`),
            {
              code: "ETIMEDOUT",
            },
          );
          stop();
        }, options.timeout);
      }
      child.stdin?.end(options.input);
    });
  } finally {
    const next = pendingAsyncGh.shift();
    if (next) {
      next.resolve();
    } else {
      activeAsyncGh -= 1;
    }
  }
}

/**
 * @param {string} filePath
 * @returns {boolean}
 */
function isExecutable(filePath) {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Explicit binary overrides may need credentials from a separate PATH entry
 * point. Forward its token only to that child; the default PATH route owns its
 * credentials and must not have them extracted or reinjected.
 *
 * @param {NodeJS.ProcessEnv} env
 * @returns {NodeJS.ProcessEnv}
 */
export function plainGhAuthenticatedEnv(env) {
  const next = plainGhEnv(env);
  if (
    !next.OPENCLAW_GH_BIN ||
    next.GH_TOKEN ||
    next.GITHUB_TOKEN ||
    next.GH_ENTERPRISE_TOKEN ||
    next.GITHUB_ENTERPRISE_TOKEN
  ) {
    return next;
  }

  const tokenEnv = { ...next };
  delete tokenEnv.OPENCLAW_GH_BIN;
  const args = ["auth", "token"];
  if (tokenEnv.GH_HOST) {
    args.push("--hostname", tokenEnv.GH_HOST);
  }
  try {
    const token = execFileSync("gh", args, {
      encoding: "utf8",
      env: tokenEnv,
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 10_000,
    }).trim();
    if (token) {
      if (tokenEnv.GH_HOST && tokenEnv.GH_HOST !== "github.com") {
        next.GH_ENTERPRISE_TOKEN = token;
      } else {
        next.GH_TOKEN = token;
      }
    }
  } catch {
    // The selected CLI may have usable credentials in its own config.
  }
  return next;
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {NodeJS.ProcessEnv}
 */
export function plainGhEnv(env = process.env) {
  const next = { ...env };
  delete next.CLICOLOR;
  delete next.CLICOLOR_FORCE;
  delete next.COLORTERM;
  delete next.GH_FORCE_TTY;
  next.NO_COLOR = "1";
  next.FORCE_COLOR = "0";
  next.CLICOLOR = "0";
  next.CLICOLOR_FORCE = "0";
  return next;
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @param {string} [cwd]
 * @returns {string}
 */
export function resolvePlainGhBin(env = process.env, cwd = process.cwd()) {
  if (env.OPENCLAW_GH_BIN) {
    if (isExecutable(env.OPENCLAW_GH_BIN)) {
      return env.OPENCLAW_GH_BIN;
    }
    throw new Error(`OPENCLAW_GH_BIN is not executable: ${env.OPENCLAW_GH_BIN}`);
  }

  if (process.versions.bun) {
    // oxlint-disable-next-line no-warning-comments -- remove after the upstream Bun PATH fix ships.
    // TODO(bun): remove this once Bun resolves empty PATH entries against the child cwd.
    const names =
      process.platform === "win32"
        ? (env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM")
            .split(";")
            .filter(Boolean)
            .map((extension) => `gh${extension.toLowerCase()}`)
        : ["gh"];
    for (const entry of (env.PATH ?? "").split(path.delimiter)) {
      for (const name of names) {
        const candidate = path.resolve(cwd, entry || ".", name);
        if (isExecutable(candidate)) {
          return candidate;
        }
      }
    }
  }

  // child_process resolves PATH in the child cwd, including relative and empty entries.
  return "gh";
}

/**
 * @overload
 * @param {readonly string[]} args
 * @param {ExecFileSyncOptionsWithStringEncoding} options
 * @returns {string}
 */
/**
 * @overload
 * @param {readonly string[]} args
 * @param {ExecFileSyncOptionsWithBufferEncoding} [options]
 * @returns {Uint8Array<ArrayBuffer>}
 */
/**
 * @overload
 * @param {readonly string[]} args
 * @param {ExecFileSyncOptions} [options]
 * @returns {string | Uint8Array<ArrayBuffer>}
 */
/**
 * @param {readonly string[]} args
 * @param {ExecFileSyncOptions} [options]
 * @returns {string | Uint8Array<ArrayBuffer>}
 */
export function execPlainGh(args, options = {}) {
  const env = plainGhAuthenticatedEnv(options.env ?? process.env);
  const ghBin = resolvePlainGhBin(env, options.cwd ?? process.cwd());
  return execFileSync(ghBin, args, {
    ...options,
    env,
    maxBuffer: options.maxBuffer ?? PLAIN_GH_MAX_BUFFER_BYTES,
  });
}

/**
 * @overload
 * @param {readonly string[]} args
 * @param {ExecFileSyncOptionsWithStringEncoding} options
 * @param {{execFileSyncImpl?: ExecGhReadImpl}} [params]
 * @returns {string}
 */
/**
 * @overload
 * @param {readonly string[]} args
 * @param {ExecFileSyncOptionsWithBufferEncoding} [options]
 * @param {{execFileSyncImpl?: ExecGhReadImpl}} [params]
 * @returns {Uint8Array<ArrayBuffer>}
 */
/**
 * @overload
 * @param {readonly string[]} args
 * @param {ExecFileSyncOptions} [options]
 * @param {{execFileSyncImpl?: ExecGhReadImpl}} [params]
 * @returns {string | Uint8Array<ArrayBuffer>}
 */
/**
 * @param {readonly string[]} args
 * @param {ExecFileSyncOptions} [options]
 * @param {{execFileSyncImpl?: ExecGhReadImpl}} [params]
 * @returns {string | Uint8Array<ArrayBuffer>}
 */
export function execGhRead(args, options = {}, params = {}) {
  const execFileSyncImpl = params.execFileSyncImpl ?? execFileSync;
  return execFileSyncImpl("gh", args, {
    ...options,
    env: ghReadEnv(options.env),
    maxBuffer: options.maxBuffer ?? PLAIN_GH_MAX_BUFFER_BYTES,
  });
}

/** @param {NodeJS.ProcessEnv} [env] */
function ghReadEnv(env) {
  const next = plainGhEnv(env);
  // Cache-aware reads stay on PATH even when another caller selects an explicit binary.
  delete next.OPENCLAW_GH_BIN;
  return next;
}

/**
 * @param {readonly string[]} args
 * @param {import("node:child_process").ExecFileOptions} [options]
 * @returns {Promise<string>}
 */
export async function execGhReadAsync(args, options = {}) {
  return runGhAsync("gh", args, {
    ...options,
    encoding: "utf8",
    env: ghReadEnv(options.env),
  });
}

/** Protected-writer counterpart with the same child environment and binary selection. */
export async function execPlainGhAsync(args, options = {}) {
  const env = plainGhAuthenticatedEnv(options.env ?? process.env);
  return runGhAsync(resolvePlainGhBin(env, options.cwd ?? process.cwd()), args, {
    ...options,
    encoding: "utf8",
    env,
  });
}

/**
 * @param {readonly string[]} args
 * @param {ExecFileSyncOptions} [options]
 * @param {{execFileSyncImpl?: ExecGhReadImpl}} [params]
 * @returns {unknown}
 */
export function execGhJson(args, options = {}, params = {}) {
  return JSON.parse(execGhRead(args, { ...options, encoding: "utf8" }, params));
}

/**
 * @param {string} repo
 * @param {string} sha
 * @param {string} event
 * @param {number} perPage
 * @returns {string[]}
 */
export function workflowRunsApiArgs(repo, sha, event, perPage) {
  return [
    "api",
    "--method",
    "GET",
    `repos/${repo}/actions/workflows/ci.yml/runs`,
    "-f",
    `event=${event}`,
    "-f",
    `head_sha=${sha}`,
    "-f",
    `per_page=${perPage}`,
  ];
}

/**
 * @overload
 * @param {string} endpoint
 * @param {ExecFileSyncOptionsWithStringEncoding} options
 * @returns {string}
 */
/**
 * @overload
 * @param {string} endpoint
 * @param {ExecFileSyncOptionsWithBufferEncoding} [options]
 * @returns {Uint8Array<ArrayBuffer>}
 */
/**
 * @overload
 * @param {string} endpoint
 * @param {ExecFileSyncOptions} [options]
 * @returns {string | Uint8Array<ArrayBuffer>}
 */
/**
 * @param {string} endpoint
 * @param {ExecFileSyncOptions} [options]
 * @returns {string | Uint8Array<ArrayBuffer>}
 */
export function execGhApiRead(endpoint, options = {}) {
  return execGhRead(["api", endpoint, "--method", "GET"], options);
}
