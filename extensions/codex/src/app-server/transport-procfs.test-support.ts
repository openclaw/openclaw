import type { ExecFileException, ExecFileOptionsWithStringEncoding } from "node:child_process";

/** Runs the real command reader against fixture bytes supplied over its stdin. */
export function createProcfsCommandFixture(
  original: typeof import("node:child_process"),
  readFile: (file: string) => string | undefined,
) {
  return (
    file: string,
    args: readonly string[],
    options: ExecFileOptionsWithStringEncoding,
    callback: (error: ExecFileException | null, stdout: string, stderr: string) => void,
  ) => {
    const evalIndex = args.indexOf("-e");
    if (file !== process.execPath || evalIndex < 0) {
      return original.execFile(file, args, options, callback);
    }
    const commandPath = `/proc/${args.at(-2)}/cmdline`;
    let data: string | undefined;
    let errorCode: string | undefined;
    try {
      data = readFile(commandPath);
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
      if (typeof code !== "string" || code === "ABORT_ERR") {
        throw error;
      }
      errorCode = code;
    }
    if (data === undefined && errorCode === undefined) {
      return original.execFile(file, args, options, callback);
    }
    const injected = `const fixtureFs = require("node:fs");
const fixtureOpen = fixtureFs.openSync;
const fixtureError = ${JSON.stringify(errorCode ?? null)};
fixtureFs.openSync = (file, ...args) => {
  if (file !== ${JSON.stringify(commandPath)}) return fixtureOpen(file, ...args);
  if (fixtureError) throw Object.assign(new Error("fixture read failure"), { code: fixtureError });
  return 0;
};
`;
    const injectedArgs = args.slice();
    injectedArgs[evalIndex + 1] = injected + injectedArgs[evalIndex + 1];
    const child = original.execFile(file, injectedArgs, options, callback);
    child.stdin?.end(data);
    return child;
  };
}

/** Supplies the same procfs bytes to synchronous inspection and asynchronous full scans. */
export function createProcfsSyncFixture(
  original: typeof import("node:fs"),
  readFile: (file: string) => string | undefined,
) {
  let nextFd = -1;
  const opened = new Map<number, { data: Buffer; position: number }>();
  return {
    openSync: (...args: Parameters<typeof original.openSync>) => {
      const file = args[0];
      const data =
        typeof file === "string" && file.startsWith("/proc/") ? readFile(file) : undefined;
      if (data === undefined) {
        return original.openSync(...args);
      }
      const fd = nextFd--;
      opened.set(fd, { data: Buffer.from(data), position: 0 });
      return fd;
    },
    readSync: (...args: Parameters<typeof original.readSync>) => {
      const [fd, target, options] = args;
      const file = opened.get(fd);
      if (!file) {
        return original.readSync(...args);
      }
      const buffer = Buffer.from(target.buffer, target.byteOffset, target.byteLength);
      const position = typeof options?.position === "number" ? options.position : file.position;
      const count = file.data.copy(
        buffer,
        options?.offset ?? 0,
        position,
        position + (options?.length ?? buffer.length),
      );
      file.position = position + count;
      return count;
    },
    closeSync: (fd: number) => {
      if (!opened.delete(fd)) {
        original.closeSync(fd);
      }
    },
  };
}
