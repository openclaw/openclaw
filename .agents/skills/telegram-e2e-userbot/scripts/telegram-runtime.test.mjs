import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.ts";
import { run, stopChildren } from "./node-test-children.mjs";
import { telegramPythonArgs } from "./telegram-runtime.mjs";

const uv = spawnSync("which", ["uv"], { encoding: "utf8" }).stdout?.trim();
const python = spawnSync(
  "uv",
  ["python", "find", "--no-project", "--no-config", "--no-python-downloads", "3.12"],
  { encoding: "utf8" },
).stdout?.trim();

// Run cold-runtime cases concurrently, leaving time for the harness to join children.
describe("Telegram runtime", { concurrency: true }, () => {
  for (const cachedTdlib of [false, true]) {
    test(
      `confined readiness reuses ${cachedTdlib ? "the pinned TDLib cache" : "uv-managed Python 3.12"}`,
      {
        skip: process.platform !== "darwin" || !uv || !python,
        timeout: 90_000,
      },
      async (context) => {
        const children = new Set();
        const execute = async (command, args, options) => {
          const result = await run(context, children, command, args, options);
          assert.equal(result.status, 0, result.stderr);
          return result.stdout.trim();
        };
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
        const version = await execute(python, [
          "-c",
          "import platform; print(platform.python_version())",
        ]);
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
        const driver = path.join(import.meta.dirname, "user-driver.py");
        const loader = `import importlib.util, pathlib, sys
spec = importlib.util.spec_from_file_location("driver", ${JSON.stringify(driver)})
driver = importlib.util.module_from_spec(spec)
spec.loader.exec_module(driver)
`;
        // Populate the driver's existing pinned extraction layout without a network
        // request or native Telegram client. Cache selection, not binary ABI, is under test.
        const cached = await execute(
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
        const userSite = await execute(
          python,
          ["-I", "-S", "-c", "import site; print(site.getusersitepackages())"],
          { env },
        );
        fs.mkdirSync(userSite, { recursive: true });
        fs.writeFileSync(
          path.join(userSite, "usercustomize.py"),
          `from pathlib import Path\nPath(${JSON.stringify(startupWrite)}).write_text("host startup ran")\n`,
        );
        // Discovery runs synchronous probes, so call it from a child the timeout can kill.
        const discovery = await execute(process.execPath, [
          "--input-type=module",
          "--eval",
          `import { createTelegramRuntimeEnvironment } from ${JSON.stringify(new URL("./telegram-runtime.mjs", import.meta.url).href)};
process.stdout.write(JSON.stringify(createTelegramRuntimeEnvironment(${JSON.stringify(state)}, ${JSON.stringify(env)})));`,
        ]);
        const runtime = JSON.parse(discovery);
        assert.equal(
          fs.existsSync(startupWrite),
          false,
          "read-only discovery ran host Python startup code",
        );
        const result = await execute(
          "/usr/bin/sandbox-exec",
          ["-f", policy, uv, ...telegramPythonArgs(runtime, script)],
          { env: { ...env, ...runtime } },
        );
        assert.equal(result, cachedTdlib ? cached : "python-3.12-ready");
      },
    );
  }
});
