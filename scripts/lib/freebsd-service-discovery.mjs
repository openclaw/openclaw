// Native rc discovery; its caller retains process termination ownership.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const MAX_OUTPUT_BYTES = 64 * 1024;
const HEADER = "openclaw-rc-discovery-v1";
const CONTEXT = {
  cwd: "/",
  env: { HOME: "/", PATH: "/sbin:/bin:/usr/sbin:/usr/bin", LC_ALL: "C" },
};

class InspectionFailure extends Error {
  constructor(reason) {
    super(reason);
    this.reason = reason;
  }
}

function fail(reason) {
  throw new InspectionFailure(reason);
}

function readStat(filename) {
  try {
    return fs.lstatSync(filename);
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }
    throw new InspectionFailure("filesystem-inspection-failed");
  }
}

function inspectPath(filename, allowMissing = false) {
  // Inspect each ancestor before accepting ENOENT. A missing final component
  // beneath an inaccessible or replaceable directory is not verified absence.
  const parts = filename.split("/").filter(Boolean);
  let current = "/";
  let result;
  for (const part of ["", ...parts]) {
    current = path.join(current, part);
    result = readStat(current);
    if (!result) {
      if (allowMissing) {
        return null;
      }
      fail("required-path-missing");
    }
    if (result.isSymbolicLink()) {
      fail("symbolic-link-needs-owner-inspection");
    }
    if (result.uid !== 0 || (result.mode & 0o022) !== 0) {
      fail("unsafe-path-ownership");
    }
    if (current !== filename && !result.isDirectory()) {
      fail("invalid-path-type");
    }
  }
  return result;
}

async function readNativeConfiguration(timeoutMs, registerExitCleanup) {
  return await new Promise((resolve, reject) => {
    const child = spawn(
      "/bin/sh",
      [
        "-c",
        `. /etc/rc.subr\nload_rc_config\nprintf '${HEADER}\\000'\nfor directory in /etc/rc.d $local_startup; do\n  executable=0\n  [ -x "$directory/openclaw" ] && executable=1\n  printf '%s\\000%s\\000' "$directory" "$executable"\ndone`,
      ],
      { ...CONTEXT, detached: true, stdio: ["ignore", "pipe", "pipe"] },
    );
    const stdout = [];
    let bytes = 0;
    let failed = false;
    let noisy = false;
    let groupCleanupAttempted = false;
    const killGroup = () => {
      if (groupCleanupAttempted || !child.pid) {
        return;
      }
      // Exit cleanup can precede the pipe deadline; never signal a recycled PGID.
      groupCleanupAttempted = true;
      try {
        // This fresh detached group belongs only to this configuration read.
        // Hard termination settles children remaining in this group after a read.
        process.kill(-child.pid, "SIGKILL"); // nosemgrep: security.opengrep.ghsa-jfv4-h8mc-jcp8.immediate-process-tree-sigkill
      } catch (error) {
        if (error.code !== "ESRCH") {
          failed = true;
        }
      }
    };
    const abort = () => {
      failed = true;
      killGroup();
      // Administrator configuration can daemonize a pipe holder outside our group.
      // Close our readers so its inherited descriptors cannot defeat the deadline.
      child.stdout.destroy();
      child.stderr.destroy();
    };
    const timer = setTimeout(abort, timeoutMs);
    // The caller owns process termination. Discovery only supplies synchronous
    // cleanup, so an early admission/status query cannot swallow its signals.
    const unregisterExitCleanup = registerExitCleanup(abort);
    child.stdout.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_OUTPUT_BYTES) {
        abort();
      } else {
        stdout.push(chunk);
      }
    });
    child.stderr.on("data", (chunk) => {
      noisy = true;
      bytes += chunk.length;
      if (bytes > MAX_OUTPUT_BYTES) {
        abort();
      }
    });
    child.once("error", () => {
      failed = true;
    });
    // The isolated group belongs to this one configuration read. Settle its
    // children even when the shell exits with a background process remaining.
    child.once("exit", killGroup);
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      unregisterExitCleanup();
      if (failed || code !== 0 || signal) {
        reject(new InspectionFailure("native-configuration-failed"));
      } else if (noisy) {
        reject(new InspectionFailure("native-configuration-output-invalid"));
      } else {
        resolve(Buffer.concat(stdout));
      }
    });
  });
}

async function discover(timeoutMs, registerExitCleanup) {
  if (process.platform !== "freebsd") {
    fail("freebsd-required");
  }
  if (process.geteuid() !== 0) {
    fail("root-required");
  }
  for (const filename of [process.execPath, "/etc/rc.subr", "/etc/defaults/rc.conf"]) {
    if (!inspectPath(filename).isFile()) {
      fail("invalid-path-type");
    }
  }

  // Match service(8)'s global load, without a service name. Loading openclaw's
  // per-service overrides here would change which script service(8) selects.
  // Administrator rc configuration is shell code, not a sandboxed data format.
  const loaded = await readNativeConfiguration(timeoutMs, registerExitCleanup);
  // Do not publish arbitrary rc output or stderr: either can contain secrets.
  // Invalid filename bytes must not become a different, apparently absent path.
  let fields;
  try {
    fields = new TextDecoder("utf-8", { fatal: true }).decode(loaded).split("\0");
  } catch {
    fail("native-configuration-output-invalid");
  }
  if (
    fields.length < 4 ||
    fields.length % 2 !== 0 ||
    fields[0] !== HEADER ||
    fields.at(-1) !== ""
  ) {
    fail("native-configuration-output-invalid");
  }
  const startup = new Map();
  for (let index = 1; index < fields.length - 1; index += 2) {
    if (!["0", "1"].includes(fields[index + 1])) {
      fail("native-configuration-output-invalid");
    }
    startup.set(fields[index], fields[index + 1] === "1");
  }
  const directories = [...startup.keys()];
  if (startup.size > 64 || directories.some((dir) => !path.isAbsolute(dir))) {
    fail("unsupported-startup-directories");
  }

  const definitions = [];
  for (const directory of directories) {
    const dirStat = inspectPath(directory, true);
    if (!dirStat) {
      continue;
    }
    if (!dirStat.isDirectory()) {
      fail("invalid-startup-directory");
    }
    const filename = path.join(directory, "openclaw");
    const stat = inspectPath(filename, true);
    if (!stat) {
      continue;
    }
    if (!stat.isFile()) {
      fail("invalid-service-definition");
    }
    definitions.push({ path: filename, executable: startup.get(directory) });
  }
  // A disabled/non-executable/custom definition remains present. Only the rc
  // script's launch owner can supply effective account, command and state facts.
  return {
    schema: 1,
    service: "openclaw",
    status: definitions.length ? "present" : "absent",
    context: CONTEXT,
    directories,
    definitions,
    selected: definitions.find((definition) => definition.executable)?.path ?? null,
  };
}

// The caller consumes this fresh observation inside its existing custody boundary.
// A result, including verified absence, is not a service-mutation capability.
export async function discoverFreeBsdService({ timeoutMs = 10_000, registerExitCleanup }) {
  try {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      fail("native-configuration-failed");
    }
    return await discover(Math.min(timeoutMs, 10_000), registerExitCleanup);
  } catch (error) {
    return {
      schema: 1,
      service: "openclaw",
      status: "unknown",
      reason: error instanceof InspectionFailure ? error.reason : "inspection-failed",
    };
  }
}
