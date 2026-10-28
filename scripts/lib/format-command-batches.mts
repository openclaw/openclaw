// Keep formatter arguments bounded even when pnpm joins them into one shell command.
const FORMAT_MAX_COMMAND_LINE_BYTES = 24 * 1024;
// Windows runs the formatter shims through `cmd.exe /d /s /c "<line>"`, and cmd.exe
// rejects a command line over 8191 characters long before the 32767-character
// CreateProcess limit applies. Leave room for the shim path and the prefix arguments.
const WINDOWS_FORMAT_MAX_COMMAND_LINE_BYTES = 7 * 1024;

function commandLineBytes(args: string[]) {
  return args.reduce((total, arg) => total + Buffer.byteLength(arg, "utf8") + 3, 0);
}

export function defaultFormatMaxCommandLineBytes(platform: string = process.platform) {
  return platform === "win32"
    ? WINDOWS_FORMAT_MAX_COMMAND_LINE_BYTES
    : FORMAT_MAX_COMMAND_LINE_BYTES;
}

export function chunkFormatFilesForCommand(
  files: string[],
  prefixArgs: string[],
  maxBytes = defaultFormatMaxCommandLineBytes(),
) {
  const chunks: string[][] = [];
  let chunk: string[] = [];
  let chunkBytes = commandLineBytes(prefixArgs);

  for (const file of files) {
    const fileBytes = Buffer.byteLength(file, "utf8") + 3;
    if (chunk.length > 0 && chunkBytes + fileBytes > maxBytes) {
      chunks.push(chunk);
      chunk = [];
      chunkBytes = commandLineBytes(prefixArgs);
    }
    chunk.push(file);
    chunkBytes += fileBytes;
  }

  if (chunk.length > 0) {
    chunks.push(chunk);
  }

  return chunks;
}
