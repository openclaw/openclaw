#!/usr/bin/env node
// Native proof runs in a disposable FreeBSD VM; all cases use a private chroot.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "freebsd" || process.geteuid() !== 0) {
  process.stderr.write("Run this native fixture as root in a disposable FreeBSD VM.\n");
  process.stderr.write("[test-freebsd-service-inspect] FAILED (exit 1)\n");
  process.exit(1);
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-rc-inspect-"));
// The inner root must be traversable after chroot drops to nobody. Its outer
// directory stays private, especially while testing a writable helper file.
fs.chmodSync(work, 0o700);
const root = path.join(work, "root");
fs.mkdirSync(root, { mode: 0o755 });
const helper = "/usr/local/libexec/openclaw-service-inspect.mjs";
const escapedCase = "deadline closes captures held by an escaped daemon";
const escapedOnly = process.argv[2] === "--escaped-pipe-only";
assert.ok(process.argv.length === 2 || (escapedOnly && process.argv.length === 3));
const escapedScript = `/pipe-holder-${path.basename(work)}.mjs`;
let escapedLaunched = false;
let mounted = false;
let noexecMounted = false;
let passed = 0;
const fixturePath = (filename) => path.join(root, filename);
const write = (filename, contents, mode = 0o644) => {
  fs.mkdirSync(path.dirname(fixturePath(filename)), { recursive: true });
  fs.writeFileSync(fixturePath(filename), contents, { mode });
  fs.chmodSync(fixturePath(filename), mode);
};

function runNode(args, { user, env = {} } = {}) {
  return spawnSync(
    "/usr/sbin/chroot",
    [
      ...(user ? ["-u", user] : []),
      root,
      "/usr/bin/env",
      "-i",
      "HOME=/",
      "PATH=/sbin:/bin:/usr/sbin:/usr/bin",
      "LC_ALL=C",
      "/usr/local/bin/node",
      ...args,
    ],
    {
      encoding: "utf8",
      timeout: 20_000,
      // The inspector handles SIGTERM; the fixture deadline must stop its own child.
      killSignal: "SIGKILL",
      env: { PATH: "/sbin:/bin:/usr/sbin:/usr/bin", ...env },
    },
  );
}

function diagnostic(result) {
  return JSON.stringify({
    status: result.status,
    signal: result.signal,
    error: result.error?.code,
    stderr: String(result.stderr ?? "")
      .replaceAll("private-fixture-value", "[redacted]")
      .slice(-4096),
  });
}

function run({ args = [], user, env = {} } = {}) {
  const result = runNode([helper, ...args], { user, env });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  assert.ok(result.stdout.length < 64 * 1024);
  assert.ok(!result.stdout.includes("private-fixture-value"));
  assert.ok(!result.stderr.includes("private-fixture-value"));
  assert.ok(result.stdout.trim(), `Inspector returned no JSON: ${diagnostic(result)}`);
  const output = JSON.parse(result.stdout);
  assert.equal(output.authority, "diagnostic-only");
  assert.equal(output.service, "openclaw");
  assert.equal(output.schema, 1);
  if (output.status === "unknown") {
    assert.equal(result.status, 1);
    assert.ok(result.stderr.endsWith("[freebsd-service-inspect] FAILED (exit 1)\n"));
  } else {
    assert.equal(result.status, 0);
    assert.equal(result.stderr, "");
  }
  return output;
}

function check(name, test) {
  if (escapedOnly && name !== escapedCase) {
    return;
  }
  process.stdout.write(`CASE ${name}\n`);
  test();
  assert.equal(fs.existsSync(fixturePath("/service-executed")), false);
  passed++;
  process.stdout.write(`PASS ${name}\n`);
}

try {
  // Real base utilities and loader, not fake rc.subr or production test hooks.
  for (const directory of [
    "/bin",
    "/sbin",
    "/lib",
    "/libexec",
    "/usr/bin",
    "/usr/sbin",
    "/usr/lib",
    "/usr/libexec",
    "/usr/local/lib",
  ]) {
    fs.mkdirSync(path.dirname(fixturePath(directory)), { recursive: true });
    // Preserve native modes and ownership, but not immutable flags on disposable copies.
    execFileSync("/bin/cp", ["-RpN", directory, fixturePath(directory)]);
  }
  fs.mkdirSync(fixturePath("/usr/local/bin"), { recursive: true });
  fs.copyFileSync(process.execPath, fixturePath("/usr/local/bin/node"));
  fs.chmodSync(fixturePath("/usr/local/bin/node"), 0o755);
  write(
    helper,
    fs.readFileSync(fileURLToPath(new URL("./freebsd-service-inspect.mjs", import.meta.url))),
  );
  for (const filename of ["/etc/rc.subr", "/etc/defaults/rc.conf", "/etc/passwd", "/etc/group"]) {
    write(filename, fs.readFileSync(filename));
  }
  // Packaged Node dependencies live outside rtld's built-in /lib and /usr/lib paths.
  fs.mkdirSync(fixturePath("/var/run"), { recursive: true });
  execFileSync("/usr/sbin/chroot", [root, "/sbin/ldconfig", "/lib", "/usr/lib", "/usr/local/lib"], {
    timeout: 20_000,
  });
  fs.mkdirSync(fixturePath("/etc/rc.d"), { recursive: true });
  fs.mkdirSync(fixturePath("/dev"));
  execFileSync("/sbin/mount", ["-t", "devfs", "devfs", fixturePath("/dev")]);
  mounted = true;
  write("/etc/rc.conf", "");

  const node = runNode(["--version"]);
  assert.equal(node.status, 0, `Chroot Node failed: ${diagnostic(node)}`);
  assert.match(node.stdout.trim(), /^v\d+\.\d+\.\d+$/);
  process.stdout.write(`chroot-node=${node.stdout.trim()}\n`);

  check("native default absence", () => assert.equal(run().status, "absent"));
  write(
    "/preload.mjs",
    'import fs from "node:fs"; fs.writeFileSync("/preloaded", "unexpected");\n',
  );
  check("documented invocation excludes Node preloads", () => {
    assert.equal(run({ env: { NODE_OPTIONS: "--import /preload.mjs" } }).status, "absent");
    assert.equal(fs.existsSync(fixturePath("/preloaded")), false);
  });
  check("non-root refusal", () => assert.equal(run({ user: "nobody" }).reason, "root-required"));
  check("fixed operation rejects arguments", () =>
    assert.equal(run({ args: ["start"] }).reason, "no-arguments-accepted"),
  );

  const definition = "#!/bin/sh\ntouch /service-executed\n";
  write("/custom/rc.d/openclaw", definition, 0o755);
  write("/second/rc.d/openclaw", definition, 0o755);
  write("/etc/rc.conf", ". /etc/root-only.conf\n");
  write("/etc/root-only.conf", 'local_startup="/custom/rc.d /second/rc.d"\n', 0o600);
  check("root-only include and shadowed definitions", () => {
    const result = run();
    assert.equal(result.status, "present");
    assert.equal(result.selected, "/custom/rc.d/openclaw");
    assert.deepEqual(
      result.definitions.map((entry) => entry.path),
      ["/custom/rc.d/openclaw", "/second/rc.d/openclaw"],
    );
  });
  check("inherited environment cannot skip native configuration", () => {
    assert.equal(
      run({ env: { _rc_conf_loaded: "true", local_startup: "/absent", NODE_OPTIONS: "" } })
        .selected,
      "/custom/rc.d/openclaw",
    );
  });
  fs.chmodSync(fixturePath("/custom/rc.d/openclaw"), 0o644);
  check("non-executable definition remains present", () => {
    const result = run();
    assert.equal(result.definitions[0].executable, false);
    assert.equal(result.selected, "/second/rc.d/openclaw");
  });
  fs.chmodSync(fixturePath("/second/rc.d/openclaw"), 0o644);
  check("no executable definition is not absence", () => {
    assert.equal(run().status, "present");
    assert.equal(run().selected, null);
  });
  write("/etc/rc.conf.d/openclaw", 'local_startup="/absent"\n');
  check("per-service overrides do not redirect global discovery", () =>
    assert.equal(run().status, "present"),
  );
  write("/etc/rc.conf", 'rc_conf_files="/etc/second.conf"\n');
  write("/etc/second.conf", 'local_startup="/custom/rc.d"\n');
  check("native rc_conf_files chaining", () =>
    assert.equal(run().definitions[0].path, "/custom/rc.d/openclaw"),
  );
  write("/etc/rc.conf", 'local_startup="/cus*/rc.d"\n');
  check("native startup glob expansion", () =>
    assert.equal(run().definitions[0].path, "/custom/rc.d/openclaw"),
  );
  fs.mkdirSync(fixturePath("/noexec"));
  execFileSync("/sbin/mount", ["-t", "tmpfs", "-o", "noexec", "tmpfs", fixturePath("/noexec")]);
  noexecMounted = true;
  write("/noexec/rc.d/openclaw", definition, 0o755);
  write("/etc/rc.conf", 'local_startup="/noexec/rc.d"\n');
  check("executable selection matches native test on a noexec mount", () => {
    const native = spawnSync("/usr/sbin/chroot", [
      root,
      "/bin/test",
      "-x",
      "/noexec/rc.d/openclaw",
    ]);
    assert.ok(native.status === 0 || native.status === 1);
    assert.equal(run().definitions[0].executable, native.status === 0);
  });
  write("/etc/rc.conf", '[ "$HOME" = / ] && local_startup="/custom/rc.d"\n');
  check("reported context matches native service discovery", () => {
    const result = run();
    const native = execFileSync(
      "/usr/sbin/chroot",
      [
        root,
        "/usr/bin/env",
        "-i",
        "HOME=/",
        "PATH=/sbin:/bin:/usr/sbin:/usr/bin",
        "LC_ALL=C",
        "/usr/sbin/service",
        "-v",
        "-l",
      ],
      { encoding: "utf8" },
    );
    assert.deepEqual(
      result.directories,
      [...native.matchAll(/^From (.*):$/gm)].map((match) => match[1]),
    );
    assert.equal(result.context.cwd, "/");
    assert.equal(result.context.env.HOME, "/");
  });
  fs.chmodSync(fixturePath("/custom/rc.d"), 0o777);
  check("writable startup directory is unknown", () =>
    assert.equal(run().reason, "unsafe-path-ownership"),
  );
  fs.chmodSync(fixturePath("/custom/rc.d"), 0o755);
  fs.renameSync(fixturePath("/custom/rc.d/openclaw"), fixturePath("/custom/rc.d/target"));
  fs.symlinkSync("target", fixturePath("/custom/rc.d/openclaw"));
  check("symlink definition is unknown", () =>
    assert.equal(run().reason, "symbolic-link-needs-owner-inspection"),
  );
  fs.unlinkSync(fixturePath("/custom/rc.d/openclaw"));
  fs.renameSync(fixturePath("/custom/rc.d/target"), fixturePath("/custom/rc.d/openclaw"));
  for (const redirect of ["", " >&2"]) {
    write("/etc/rc.conf", `echo private-fixture-value${redirect}\n`);
    check(`native output is rejected and redacted ${redirect || "stdout"}`, () =>
      assert.equal(run().reason, "native-configuration-output-invalid"),
    );
  }
  const bytePath = Buffer.concat([Buffer.from("/nonutf8-"), Buffer.from([255])]);
  fs.mkdirSync(Buffer.concat([Buffer.from(root), bytePath]));
  fs.writeFileSync(
    Buffer.concat([Buffer.from(root), bytePath, Buffer.from("/openclaw")]),
    definition,
    { mode: 0o755 },
  );
  write(
    "/etc/rc.conf",
    Buffer.concat([Buffer.from('local_startup="'), bytePath, Buffer.from('"\n')]),
  );
  check("invalid path bytes cannot become absence", () =>
    assert.equal(run().reason, "native-configuration-output-invalid"),
  );
  write("/etc/rc.conf", "while :; do :; done\n");
  check("native configuration deadline", () =>
    assert.equal(run().reason, "native-configuration-failed"),
  );
  write("/etc/rc.conf", "/bin/sleep 60 &\necho $! > /child.pid\nwait\n");
  check("deadline settles configuration children", () => {
    assert.equal(run().reason, "native-configuration-failed");
    const pid = fs.readFileSync(fixturePath("/child.pid"), "utf8").trim();
    assert.match(pid, /^[1-9][0-9]*$/);
    let alive = true;
    for (let attempt = 0; attempt < 20; attempt++) {
      const status = spawnSync("/bin/ps", ["-p", pid, "-o", "stat="], { encoding: "utf8" });
      if (status.status !== 0 || !status.stdout.trim() || status.stdout.trim().startsWith("Z")) {
        alive = false;
        break;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
    assert.equal(alive, false, "configuration child remains live");
  });
  write(
    escapedScript,
    'import fs from "node:fs"; fs.writeFileSync("/pipe-holder.pid", String(process.pid)); setTimeout(() => {}, 60_000);\n',
  );
  write("/etc/rc.conf", `/usr/sbin/daemon /usr/local/bin/node ${escapedScript}\n`);
  check(escapedCase, () => {
    escapedLaunched = true;
    const started = performance.now();
    assert.equal(run().reason, "native-configuration-failed");
    process.stdout.write(`escaped-pipe elapsed-ms=${Math.round(performance.now() - started)}\n`);
    const pid = fs.readFileSync(fixturePath("/pipe-holder.pid"), "utf8").trim();
    assert.match(pid, /^[1-9][0-9]*$/);
    assert.equal(
      execFileSync("/bin/ps", ["-ww", "-p", pid, "-o", "command="], { encoding: "utf8" }).trim(),
      `/usr/local/bin/node ${escapedScript}`,
    );
  });
  write("/etc/rc.conf", "");
  fs.chmodSync(fixturePath(helper), 0o666);
  check("writable helper is rejected", () => assert.equal(run().reason, "unsafe-path-ownership"));
  process.stdout.write(`${passed} native cases passed\n`);
} catch (error) {
  process.stderr.write(`${error.stack}\n`);
  process.exitCode = 1;
} finally {
  let cleanupStage = "escaped-pipe-holder";
  try {
    if (escapedLaunched) {
      // This fixture owns the recorded PID and its unique script, not an argv census.
      const pid = fs.readFileSync(fixturePath("/pipe-holder.pid"), "utf8").trim();
      assert.match(pid, /^[1-9][0-9]*$/);
      assert.equal(
        execFileSync("/bin/ps", ["-ww", "-p", pid, "-o", "command="], { encoding: "utf8" }).trim(),
        `/usr/local/bin/node ${escapedScript}`,
      );
      process.kill(Number(pid), "SIGTERM");
      let alive = true;
      for (let attempt = 0; attempt < 100; attempt++) {
        const status = spawnSync("/bin/ps", ["-p", pid, "-o", "stat="], { encoding: "utf8" });
        assert.ifError(status.error);
        assert.equal(status.signal, null);
        assert.ok(status.status === 0 || status.status === 1);
        assert.equal(status.stderr, "");
        if (!status.stdout.trim() || status.stdout.trim().startsWith("Z")) {
          alive = false;
          break;
        }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
      }
      assert.equal(alive, false, "escaped pipe holder remains live");
      process.stdout.write("escaped-pipe-holder cleanup=complete\n");
    }
    cleanupStage = "unmount-noexec";
    if (noexecMounted) {
      execFileSync("/sbin/umount", [fixturePath("/noexec")]);
    }
    cleanupStage = "unmount-devfs";
    if (mounted) {
      execFileSync("/sbin/umount", [fixturePath("/dev")]);
    }
    const flags = spawnSync(
      "/usr/bin/find",
      [root, "-flags", "+schg,sappnd,uchg,uappnd", "-print"],
      { encoding: "utf8", timeout: 20_000, maxBuffer: 4096 },
    );
    process.stdout.write(
      `fixture-immutable-flags=${diagnostic(flags)} paths=${JSON.stringify((flags.stdout ?? "").slice(-4096))}\n`,
    );
    if (flags.error || flags.status !== 0) {
      process.exitCode = 1;
    }
    cleanupStage = "remove-fixture";
    fs.rmSync(work, { recursive: true, force: true });
    process.stdout.write("fixture-cleanup=complete\n");
  } catch (error) {
    process.stderr.write(
      `Fixture cleanup failed at ${cleanupStage}; retained ${work}: ${JSON.stringify({
        code: error.code,
        syscall: error.syscall,
        path: error.path,
        stderr: String(error.stderr ?? "").slice(-4096),
      })}\n`,
    );
    process.exitCode = 1;
  }
}
if (process.exitCode) {
  process.stderr.write("[test-freebsd-service-inspect] FAILED (exit 1)\n");
}
