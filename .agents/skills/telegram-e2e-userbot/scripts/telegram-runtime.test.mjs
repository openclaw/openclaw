import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.ts";
import { telegramPythonArgs } from "./telegram-runtime.mjs";

const uv = spawnSync("which", ["uv"], { encoding: "utf8" }).stdout?.trim();
const python = spawnSync(
  "uv",
  ["python", "find", "--no-project", "--no-config", "--no-python-downloads", "3.12"],
  { encoding: "utf8" },
).stdout?.trim();

// Each case runs about ten cold Node/uv/Python processes, a few seconds on a loaded
// host. The cases run concurrently so the file stays inside the harness's 120 s
// budget for the whole Node suite, with time left for the after hooks to join children.
const TEST_TIMEOUT_MS = 90_000;

// Completion is the child closing its pipes; only the test timeout bounds a stalled
// host. The test's after hook kills and joins whatever a timed-out body left running.
function run(context, children, command, args, options) {
  context.signal.throwIfAborted();
  const child = spawn(command, args, {
    ...options,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.setEncoding("utf8").on("data", (chunk) => {
    stderr += chunk;
  });
  const closed = new Promise((resolve) => {
    child.once("close", (status, signal) => resolve({ status, signal, stdout, stderr }));
  });
  children.add({ child, closed });
  return new Promise((resolve, reject) => {
    const abort = () => {
      const error = new Error(
        `Child did not finish before the test ended:\n${stderr.slice(-4000)}`,
        {
          cause: context.signal.reason,
        },
      );
      context.diagnostic(error.message);
      reject(error);
    };
    context.signal.addEventListener("abort", abort, { once: true });
    child.once("error", reject);
    closed.then(resolve).finally(() => context.signal.removeEventListener("abort", abort));
  });
}

// A descendant can hold the pipes after its parent exits, so always kill the group.
async function stopChildren(children) {
  for (const { child } of children) {
    if (child.pid) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch (error) {
        if (error.code !== "ESRCH" && error.code !== "EPERM") {
          throw error;
        }
      }
    }
  }
  await Promise.all([...children].map(({ closed }) => closed));
}

describe("Telegram runtime", { concurrency: true }, () => {
  for (const cachedTdlib of [false, true]) {
    test(
      `confined readiness reuses ${cachedTdlib ? "the pinned TDLib cache" : "uv-managed Python 3.12"}`,
      {
        skip: process.platform !== "darwin" || !uv || !python,
        timeout: TEST_TIMEOUT_MS,
      },
      async (context) => {
        // One after hook joins every child before removing the root: node:test runs after
        // hooks in registration order and skips the rest once one throws.
        const children = new Set();
        const temporary = useAutoCleanupTempDirTracker((cleanup) =>
          context.after(async () => {
            await stopChildren(children);
            cleanup();
          }),
        );
        const root = temporary.make("telegram-runtime-");
        const host = path.join(root, "host");
        const state = path.join(root, "state");
        const bin = path.join(host, "bin");
        const managed = path.join(host, ".local/share/uv/python");
        // Real uv discovery with no compatible interpreter on PATH. The installed
        // executable is real Python 3.12; only its managed-install location is a fixture.
        const version = (
          await run(context, children, python, [
            "-c",
            "import platform; print(platform.python_version())",
          ])
        ).stdout.trim();
        const installation = path.join(
          managed,
          `cpython-${version}-macos-${process.arch === "arm64" ? "aarch64" : "x86_64"}-none`,
          "bin",
        );
        fs.mkdirSync(installation, { recursive: true });
        fs.mkdirSync(bin, { recursive: true });
        fs.mkdirSync(state);
        fs.symlinkSync(python, path.join(installation, "python3.12"));
        fs.symlinkSync(uv, path.join(bin, "uv"));
        if (cachedTdlib) {
          fs.symlinkSync(python, path.join(bin, "python3"));
        }
        const env = { HOME: host, PATH: bin, UV_OFFLINE: "1", UV_PYTHON_DOWNLOADS: "never" };
        const approved = await run(
          context,
          children,
          uv,
          [
            "python",
            "find",
            "--no-project",
            "--no-config",
            "--offline",
            "--no-python-downloads",
            "3.12",
          ],
          { env: { ...env, UV_CACHE_DIR: path.join(state, "preflight-cache") } },
        );
        assert.equal(approved.status, 0, approved.stderr);
        const driver = path.join(import.meta.dirname, "user-driver.py");
        const loader = `import importlib.util, pathlib, sys
spec = importlib.util.spec_from_file_location("driver", ${JSON.stringify(driver)})
driver = importlib.util.module_from_spec(spec)
spec.loader.exec_module(driver)
`;
        // Populate the driver's existing pinned extraction layout without a network
        // request or native Telegram client. Cache selection, not binary ABI, is under test.
        const cache = await run(
          context,
          children,
          python,
          [
            "-B",
            "-c",
            loader +
              `entry = driver.TDLIB_PREBUILT[(driver.platform.system().lower(), driver.platform.machine().lower())]
p = driver.TDLIB_CACHE_ROOT / entry[2][:16] / "package" / entry[1]
p.parent.mkdir(parents=True)
p.write_bytes(b"already-verified-cache-fixture")
print(p)`,
          ],
          { env },
        );
        assert.equal(cache.status, 0, cache.stderr);
        const cached = cache.stdout.trim();
        const script = path.join(root, "readiness.py");
        fs.writeFileSync(
          script,
          loader +
            (cachedTdlib
              ? `p = driver.find_tdjson({})\nassert p.read_bytes() == b"already-verified-cache-fixture"\nprint(p)\n`
              : "assert sys.version_info[:2] == (3, 12)\nprint('python-3.12-ready')\n"),
        );
        const policy = path.join(root, "isolation.sb");
        fs.writeFileSync(
          policy,
          `(version 1)\n(allow default)\n(deny network*)\n(deny file-write*)\n(allow file-write* (subpath ${JSON.stringify(state)}))\n`,
        );
        const startupWrite = path.join(host, "unexpected-startup-write");
        const userSite = (
          await run(
            context,
            children,
            python,
            ["-I", "-S", "-c", "import site; print(site.getusersitepackages())"],
            { env },
          )
        ).stdout.trim();
        fs.mkdirSync(userSite, { recursive: true });
        fs.writeFileSync(
          path.join(userSite, "usercustomize.py"),
          `from pathlib import Path\nPath(${JSON.stringify(startupWrite)}).write_text("host startup ran")\n`,
        );
        // Discovery runs synchronous probes, so call it from a child the timeout can kill.
        const discovery = await run(context, children, process.execPath, [
          "--input-type=module",
          "--eval",
          `import { createTelegramRuntimeEnvironment } from ${JSON.stringify(new URL("./telegram-runtime.mjs", import.meta.url).href)};
process.stdout.write(JSON.stringify(createTelegramRuntimeEnvironment(${JSON.stringify(state)}, ${JSON.stringify(env)})));`,
        ]);
        assert.equal(discovery.status, 0, discovery.stderr);
        const runtime = JSON.parse(discovery.stdout);
        assert.equal(
          fs.existsSync(startupWrite),
          false,
          "read-only discovery ran host Python startup code",
        );
        const result = await run(
          context,
          children,
          "/usr/bin/sandbox-exec",
          ["-f", policy, uv, ...telegramPythonArgs(runtime, script)],
          { env: { ...env, ...runtime } },
        );
        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.stdout.trim(), cachedTdlib ? cached : "python-3.12-ready");
        assert.equal(fs.readFileSync(cached, "utf8"), "already-verified-cache-fixture");
      },
    );
  }
});
