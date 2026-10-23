/** Live process, listener, and exact-profile ownership proof for managed Chromium. */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { getFileLockProcessStartTime, isPidAlive } from "openclaw/plugin-sdk/process-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { type BrowserExecutable, isChromeExecutableFamilyMatch } from "./chrome.executables.js";
import type { ResolvedBrowserProfile } from "./config.js";

const TCP_LISTEN_STATE_HEX = "0A";

function readLinuxProcessArgv(pid: number): string[] | null {
  let cmdline: Buffer;
  try {
    cmdline = fs.readFileSync(`/proc/${pid}/cmdline`);
  } catch {
    return null;
  }
  const argv = cmdline
    .toString("utf8")
    .split("\0")
    .filter((arg) => arg.length > 0);
  return argv.length > 0 ? argv : null;
}

function readPsCommandLine(pid: number): string | null {
  try {
    return (
      normalizeOptionalString(
        execFileSync("ps", ["-ww", "-p", String(pid), "-o", "command="], {
          encoding: "utf8",
          timeout: 1000,
          maxBuffer: 64 * 1024,
        }),
      ) ?? null
    );
  } catch {
    return null;
  }
}

export function readManagedProcessCommandLine(pid: number): {
  argv: string[] | null;
  text: string;
  startTime: number;
} | null {
  if (process.platform !== "linux" && process.platform !== "darwin") {
    return null;
  }
  const startTime = getFileLockProcessStartTime(pid);
  if (startTime === null) {
    return null;
  }
  const argv = process.platform === "linux" ? readLinuxProcessArgv(pid) : null;
  const text = process.platform === "linux" ? argv?.join(" ") : readPsCommandLine(pid);
  return text ? { argv, text, startTime } : null;
}

function processCommandFlagValues(
  command: { argv: string[] | null; text: string },
  name: "remote-debugging-port" | "user-data-dir",
): string[] {
  const flag = `--${name}=`;
  if (command.argv) {
    return command.argv.filter((arg) => arg.startsWith(flag)).map((arg) => arg.slice(flag.length));
  }
  return [...command.text.matchAll(new RegExp(`(?:^|\\s)${flag}(.*?)(?=\\s--|$)`, "g"))].flatMap(
    (match) => (match[1] === undefined ? [] : [match[1]]),
  );
}

export function processCommandHasFlag(
  command: { argv: string[] | null; text: string },
  name: "remote-debugging-port" | "user-data-dir",
  value: string,
): boolean {
  // macOS ps flattens argv; a sibling path or a duplicate flag is not ownership proof.
  const values = processCommandFlagValues(command, name);
  return values.length === 1 && values[0] === value;
}

function commandLineMatchesManagedChrome(params: {
  command: { argv: string[] | null; text: string };
  exe: BrowserExecutable;
  profile: ResolvedBrowserProfile;
  userDataDir: string;
}): boolean {
  return (
    isChromeExecutableFamilyMatch(params.command.text, params.exe) &&
    processCommandHasFlag(
      params.command,
      "remote-debugging-port",
      String(params.profile.cdpPort),
    ) &&
    processCommandHasFlag(params.command, "user-data-dir", params.userDataDir)
  );
}

function parseLinuxTcpListenInodesForPort(table: string, port: number): Set<string> {
  const expectedPort = port.toString(16).toUpperCase().padStart(4, "0");
  const inodes = new Set<string>();
  for (const line of table.split(/\r?\n/).slice(1)) {
    const fields = line.trim().split(/\s+/);
    const localAddress = fields[1] ?? "";
    const state = fields[3] ?? "";
    const inode = fields[9] ?? "";
    const localPort = localAddress.split(":").at(-1)?.toUpperCase();
    if (localPort === expectedPort && state === TCP_LISTEN_STATE_HEX && inode) {
      inodes.add(inode);
    }
  }
  return inodes;
}

function readLinuxTcpListenInodesForPort(port: number): Set<string> {
  const inodes = new Set<string>();
  for (const tablePath of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    try {
      for (const inode of parseLinuxTcpListenInodesForPort(
        fs.readFileSync(tablePath, "utf8"),
        port,
      )) {
        inodes.add(inode);
      }
    } catch {
      // Missing proc tables mean this platform cannot prove listener ownership.
    }
  }
  return inodes;
}

function linuxPidOwnsAnySocketInode(pid: number, inodes: Set<string>): boolean {
  if (inodes.size === 0) {
    return false;
  }
  let descriptors: string[];
  try {
    descriptors = fs.readdirSync(`/proc/${pid}/fd`);
  } catch {
    return false;
  }
  for (const descriptor of descriptors) {
    let target: string;
    try {
      target = fs.readlinkSync(`/proc/${pid}/fd/${descriptor}`);
    } catch {
      continue;
    }
    const match = /^socket:\[(?<inode>\d+)\]$/.exec(target);
    if (match?.groups?.inode && inodes.has(match.groups.inode)) {
      return true;
    }
  }
  return false;
}

function linuxPidListensOnPort(pid: number, port: number): boolean {
  return linuxPidOwnsAnySocketInode(pid, readLinuxTcpListenInodesForPort(port));
}

function lsofShowsPidListeningOnPort(pid: number, port: number): boolean {
  try {
    const output = execFileSync(
      "lsof",
      ["-nP", "-a", "-p", String(pid), `-iTCP:${port}`, "-sTCP:LISTEN", "-Fp"],
      { encoding: "utf8", timeout: 1000, maxBuffer: 64 * 1024 },
    );
    return output.split(/\r?\n/).some((line) => line === `p${pid}`);
  } catch {
    return false;
  }
}

export function pidListensOnPort(pid: number, port: number): boolean {
  if (process.platform === "linux") {
    return linuxPidListensOnPort(pid, port);
  }
  if (process.platform === "darwin") {
    return lsofShowsPidListeningOnPort(pid, port);
  }
  return false;
}

export function readPortListenerPids(port: number): number[] {
  try {
    if (process.platform === "linux") {
      const inodes = readLinuxTcpListenInodesForPort(port);
      if (inodes.size === 0) {
        return [];
      }
      return fs
        .readdirSync("/proc")
        .filter((entry) => /^\d+$/.test(entry))
        .map(Number)
        .filter((pid) => linuxPidOwnsAnySocketInode(pid, inodes));
    }
    if (process.platform === "darwin") {
      const output = execFileSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fp"], {
        encoding: "utf8",
        timeout: 1000,
        maxBuffer: 64 * 1024,
      });
      return [...new Set([...output.matchAll(/^p(\d+)$/gm)].map((match) => Number(match[1])))];
    }
  } catch {
    // Discovery failure never proves absence; callers must still probe the port.
  }
  return [];
}

export function isHeadlessShellExecutable(executable: string): boolean {
  return /(?:^|[\\/])(?:chrome-headless-shell|headless_shell)(?:\.exe)?$/i.test(executable);
}

function headlessShellExecutable(command: { argv: string[] | null; text: string }): string | null {
  // Managed launch arguments are flags; preserve spaces in macOS executable paths.
  const executable = command.argv?.[0] ?? command.text.split(/\s--/, 1)[0] ?? "";
  return isHeadlessShellExecutable(executable) ? executable : null;
}

function readHeadlessShellProfilePids(userDataDir: string): number[] | null {
  const pids: number[] = [];
  const addProfileOwner = (pid: number, command: { argv: string[] | null; text: string }) => {
    if (
      headlessShellExecutable(command) &&
      // Ambiguous duplicate flags cannot prove ownership, but must preserve data.
      processCommandFlagValues(command, "user-data-dir").includes(userDataDir) &&
      isPidAlive(pid)
    ) {
      pids.push(pid);
    }
  };
  try {
    if (process.platform === "linux") {
      for (const entry of fs.readdirSync("/proc")) {
        if (!/^\d+$/.test(entry)) {
          continue;
        }
        const pid = Number(entry);
        const argv = readLinuxProcessArgv(pid);
        if (argv) {
          addProfileOwner(pid, { argv, text: argv.join(" ") });
        }
      }
    } else if (process.platform === "darwin") {
      const output = execFileSync("ps", ["-axww", "-o", "pid=,command="], {
        encoding: "utf8",
        timeout: 1000,
        maxBuffer: 1024 * 1024,
      });
      for (const line of output.split(/\r?\n/)) {
        const match = /^\s*(\d+)\s+(.+)$/.exec(line);
        if (match?.[1] && match[2] !== undefined) {
          addProfileOwner(Number(match[1]), { argv: null, text: match[2] });
        }
      }
    }
  } catch {
    return null;
  }
  return pids;
}

export function headlessShellProfileInUseReason(userDataDir: string): string | undefined {
  const pids = readHeadlessShellProfilePids(userDataDir);
  if (pids === null) {
    return "Headless shell profile ownership could not be verified";
  }
  return pids.length > 0 ? "A headless shell process still uses the profile data" : undefined;
}

export type ManagedChromeProcessIdentity = {
  pid: number;
  startTime: number;
  commandLine: string;
};

export function sameManagedChromeIdentity(
  a: ManagedChromeProcessIdentity,
  b: ManagedChromeProcessIdentity,
): boolean {
  return a.pid === b.pid && a.commandLine === b.commandLine && a.startTime === b.startTime;
}

export function readOwnedManagedChromeIdentity(params: {
  pid: number;
  exe: BrowserExecutable;
  profile: ResolvedBrowserProfile;
  userDataDir: string;
  headlessShellOnly?: boolean;
}): ManagedChromeProcessIdentity | null {
  if (!isPidAlive(params.pid) || !pidListensOnPort(params.pid, params.profile.cdpPort)) {
    return null;
  }
  const command = readManagedProcessCommandLine(params.pid);
  if (
    !command ||
    (params.headlessShellOnly && !headlessShellExecutable(command)) ||
    !commandLineMatchesManagedChrome({
      command,
      exe: params.exe,
      profile: params.profile,
      userDataDir: params.userDataDir,
    })
  ) {
    return null;
  }
  return {
    pid: params.pid,
    startTime: command.startTime,
    commandLine: command.text,
  };
}

/** A live shell remains owned even when launch discovery changes or its cache is removed. */
export function readOwnedManagedHeadlessShell(params: {
  pid: number;
  profile: ResolvedBrowserProfile;
  userDataDir: string;
}): { exe: BrowserExecutable; identity: ManagedChromeProcessIdentity } | null {
  const command = readManagedProcessCommandLine(params.pid);
  const executable = command && headlessShellExecutable(command);
  if (!executable) {
    return null;
  }
  const exe: BrowserExecutable = { kind: "chromium", path: executable };
  const identity = readOwnedManagedChromeIdentity({ ...params, exe, headlessShellOnly: true });
  return identity ? { exe, identity } : null;
}
