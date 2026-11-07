import { closeSync, openSync, readSync, readdirSync, readlinkSync, writeSync } from "node:fs";
import { basename } from "node:path";

// Sample this process's network namespace, never argv, env or request data.
// Limits and unavailable /proc entries are explicit; observation is best effort.
export function writeMockListenDiagnostic(phase, port, launchCount) {
  const snapshot = {
    event: "mock-openai-bind-diagnostic",
    phase,
    port,
    launchCount,
    mockPid: process.pid,
    networkNamespace: null,
    sockets: [],
    truncated: false,
    unavailable: 0,
  };
  const attempt = (read, fallback) => {
    try {
      return read();
    } catch {
      snapshot.unavailable++;
      return fallback;
    }
  };
  const bounded = (values, limit) => {
    snapshot.truncated ||= values.length > limit;
    return values.slice(0, limit);
  };
  snapshot.networkNamespace = attempt(() => readlinkSync("/proc/self/ns/net"), null);
  for (const family of ["tcp", "tcp6"]) {
    const table = attempt(() => {
      const fd = openSync("/proc/self/net/" + family, "r");
      try {
        const buffer = Buffer.alloc(256 * 1024);
        let length = 0;
        while (length < buffer.length) {
          const count = readSync(fd, buffer, length, buffer.length - length, null);
          if (count === 0) {
            break;
          }
          length += count;
        }
        snapshot.truncated ||= length === buffer.length;
        // Ignore a partial last row when the byte bound is reached.
        const text = buffer.toString("utf8", 0, length);
        return text.slice(0, text.lastIndexOf("\n"));
      } finally {
        closeSync(fd);
      }
    }, "");
    for (const line of table.split("\n").slice(1)) {
      const fields = line.trim().split(/\s+/u);
      const localPort = Number.parseInt(fields[1]?.split(":")[1], 16);
      const remotePort = Number.parseInt(fields[2]?.split(":")[1], 16);
      if (localPort !== port && remotePort !== port) {
        continue;
      }
      if (snapshot.sockets.length === 64) {
        snapshot.truncated = true;
        break;
      }
      snapshot.sockets.push({
        family,
        state: fields[3],
        localPort,
        remotePort,
        inode: fields[9],
        owners: [],
      });
    }
  }
  const socketsByInode = new Map();
  for (const socket of snapshot.sockets) {
    if (socket.inode !== "0") {
      const sockets = socketsByInode.get(socket.inode) ?? [];
      sockets.push(socket);
      socketsByInode.set(socket.inode, sockets);
    }
  }
  if (socketsByInode.size) {
    const pids = bounded(
      attempt(() => readdirSync("/proc"), []).filter((pid) => /^\d+$/u.test(pid)),
      2048,
    );
    for (const pid of pids) {
      const fds = bounded(
        attempt(() => readdirSync("/proc/" + pid + "/fd"), []),
        1024,
      );
      const owned = new Set();
      for (const fd of fds) {
        const link = attempt(() => readlinkSync("/proc/" + pid + "/fd/" + fd), "");
        const inode = /^socket:\[(\d+)\]$/u.exec(link)?.[1];
        if (socketsByInode.has(inode)) {
          owned.add(inode);
        }
      }
      if (!owned.size) {
        continue;
      }
      const executable = attempt(() => basename(readlinkSync("/proc/" + pid + "/exe")), null);
      for (const inode of owned) {
        for (const socket of socketsByInode.get(inode)) {
          if (socket.owners.length < 8) {
            socket.owners.push({ pid: Number(pid), basename: executable });
          } else {
            snapshot.truncated = true;
          }
        }
      }
    }
  }
  // Synchronous stderr survives the following unhandled error. Diagnostics must
  // never replace the original bind failure if the output stream is unavailable.
  attempt(() => writeSync(2, JSON.stringify(snapshot) + "\n"), undefined);
}
