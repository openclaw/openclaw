/** Supplies fixture bytes through the same async descriptor boundary as procfs. */
export function createProcfsFixture(
  original: typeof import("node:fs/promises"),
  readFile: (file: string) => string | undefined | Promise<string | undefined>,
  readPids?: () => string[] | undefined,
) {
  return {
    open: async (...args: Parameters<typeof original.open>) => {
      const file = args[0];
      const data =
        typeof file === "string" && file.startsWith("/proc/") ? await readFile(file) : undefined;
      if (data === undefined) {
        return original.open(...args);
      }
      const bytes = Buffer.from(data);
      let position = 0;
      return {
        read: async (buffer: Buffer, offset: number, length: number, at: number | null) => {
          const start = at ?? position;
          const bytesRead = bytes.copy(buffer, offset, start, start + length);
          position = start + bytesRead;
          return { bytesRead, buffer };
        },
        close: async () => {},
      };
    },
    readdir: async (...args: Parameters<typeof original.readdir>) => {
      const entries = args[0] === "/proc" ? readPids?.() : undefined;
      return entries ?? original.readdir(...args);
    },
  };
}
