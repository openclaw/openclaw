import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import { hasUnjoinedWork, runManagedCommand } from "./lib/managed-child-process.mts";

type UserVerification = { ok: true } | { ok: false; reason: string; unjoined?: true };
const stdoutLimit = 1024 * 1024;
const stderrLimit = 64 * 1024;

function inspectUsers(output: string, ignoredIdentities: Set<string>): UserVerification {
  if (!output.endsWith("\n") || output.includes("\0")) {
    return { ok: false, reason: "lsof returned malformed staging-user records." };
  }
  const users = new Set<number>();
  let pid: number | undefined;
  let file: { device?: string; inode?: string } | undefined;
  let processHasFile = false;
  const finishFile = () => {
    if (!file) {
      return true;
    }
    if (file.device === undefined || file.inode === undefined) {
      return false;
    }
    // Device/inode fields avoid lsof's locale-dependent pathname escaping.
    // Only this process's exact held lock is exempt; other files remain users.
    if (pid !== process.pid || !ignoredIdentities.has(file.device + ":" + file.inode)) {
      users.add(pid!);
    }
    processHasFile = true;
    file = undefined;
    return true;
  };
  for (const line of output.slice(0, -1).split("\n")) {
    const value = line.slice(1);
    if (line.startsWith("p") && /^[1-9]\d*$/u.test(value)) {
      if (!finishFile() || (pid !== undefined && !processHasFile)) {
        return { ok: false, reason: "lsof returned incomplete staging-user records." };
      }
      pid = Number(value);
      processHasFile = false;
      if (!Number.isSafeInteger(pid) || pid > 0x7fffffff) {
        return { ok: false, reason: "lsof returned an invalid staging-user PID." };
      }
    } else if (line.startsWith("f") && /^[a-z0-9]+$/iu.test(value) && pid !== undefined) {
      if (!finishFile()) {
        return { ok: false, reason: "lsof returned incomplete staging-user records." };
      }
      file = {};
    } else if (
      line.startsWith("D") &&
      /^0x[a-f0-9]{1,16}$/iu.test(value) &&
      file &&
      file.device === undefined
    ) {
      file.device = String(BigInt(value));
    } else if (
      line.startsWith("i") &&
      /^[1-9]\d{0,19}$/u.test(value) &&
      file &&
      file.inode === undefined
    ) {
      file.inode = value;
    } else {
      return { ok: false, reason: "lsof returned unknown staging-user records." };
    }
  }
  if (!finishFile() || pid === undefined || !processHasFile) {
    return { ok: false, reason: "lsof returned incomplete staging-user records." };
  }
  if (users.size) {
    const listed = [...users].slice(0, 16).join(", ");
    return {
      ok: false,
      reason: `Live staging users remain (PIDs ${listed}${users.size > 16 ? ", …" : ""}).`,
    };
  }
  return { ok: true };
}

export async function verifyNoStagingUsers(params: {
  roots: string[];
  ignoredFiles?: string[];
  signal?: AbortSignal;
}): Promise<UserVerification> {
  let captureFailure: string | undefined;
  try {
    params.signal?.throwIfAborted();
    const binary =
      process.platform === "darwin"
        ? "/usr/sbin/lsof"
        : process.platform === "linux"
          ? "/usr/bin/lsof"
          : undefined;
    if (!binary || params.roots.length === 0) {
      return { ok: false, reason: "A supported lsof staging-user check is unavailable." };
    }
    const roots = [...new Set(params.roots)];
    const ignoredFiles = new Set(params.ignoredFiles ?? []);
    const ignoredIdentities = new Set<string>();
    for (const root of roots) {
      if (!isAbsolute(root) || realpathSync(root) !== root || !lstatSync(root).isDirectory()) {
        return { ok: false, reason: "Staging-user check requires canonical directory paths." };
      }
    }
    for (const file of ignoredFiles) {
      const stat = lstatSync(file, { bigint: true });
      if (!isAbsolute(file) || realpathSync(file) !== file || !stat.isFile() || stat.nlink !== 1n) {
        return {
          ok: false,
          reason: "Staging-user lock exemption requires a canonical regular file.",
        };
      }
      ignoredIdentities.add(stat.dev + ":" + stat.ino);
    }
    const deadline = Date.now() + 60_000;
    for (const root of roots) {
      const timeoutMs = deadline - Date.now();
      if (timeoutMs <= 0) {
        return { ok: false, reason: "Staging-user inspection exceeded its time limit." };
      }
      const abort = new AbortController();
      const signal = params.signal ? AbortSignal.any([params.signal, abort.signal]) : abort.signal;
      const stdout = Buffer.alloc(stdoutLimit);
      let stdoutBytes = 0;
      let stderrBytes = 0;
      const exceedLimit = () => {
        captureFailure ??= "lsof staging-user output exceeded its limit.";
        abort.abort(new Error(captureFailure));
      };
      const code = await runManagedCommand({
        bin: binary,
        args: ["-nP", "-FpfDi", "+D", root],
        env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LC_ALL: "C" },
        stdio: ["ignore", "pipe", "pipe"],
        timeoutMs,
        signal,
        requireProcessTreeExit: true,
        onReady(child) {
          if (!child.stdout || !child.stderr) {
            throw new Error("lsof output streams are unavailable.");
          }
          child.stdout.on("data", (chunk: Buffer) => {
            if (captureFailure) {
              return;
            }
            if (stdoutBytes + chunk.length > stdoutLimit) {
              exceedLimit();
              return;
            }
            stdoutBytes += chunk.copy(stdout, stdoutBytes);
          });
          child.stderr.on("data", (chunk: Buffer) => {
            stderrBytes += chunk.length;
            if (stderrBytes > stderrLimit) {
              exceedLimit();
            }
          });
        },
      });
      params.signal?.throwIfAborted();
      if (captureFailure) {
        return { ok: false, reason: captureFailure };
      }
      if (stderrBytes) {
        return { ok: false, reason: "lsof reported an incomplete staging-user inspection." };
      }
      if (code === 1 && stdoutBytes === 0) {
        continue;
      }
      // +D exits 1 when any searched file has no users, even if other files
      // produced valid records. Actual scan errors also emit stderr, checked above.
      if ((code !== 0 && code !== 1) || stdoutBytes === 0) {
        return { ok: false, reason: "lsof did not complete a valid staging-user inspection." };
      }
      const inspected = inspectUsers(
        stdout.subarray(0, stdoutBytes).toString("utf8"),
        ignoredIdentities,
      );
      if (!inspected.ok) {
        return inspected;
      }
    }
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      reason: captureFailure ?? "lsof could not verify the absence of staging users.",
      ...(hasUnjoinedWork(error) ? { unjoined: true as const } : {}),
    };
  }
}
