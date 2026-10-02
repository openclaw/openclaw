// Keep formatter arguments bounded even when pnpm joins them into one shell command.
export const FORMAT_MAX_COMMAND_LINE_BYTES = 24 * 1024;

function commandLineBytes(args: string[]) {
  return args.reduce((total, arg) => total + Buffer.byteLength(arg, "utf8") + 3, 0);
}

export function chunkFormatFilesForCommand(
  files: string[],
  prefixArgs: string[],
  maxBytes = FORMAT_MAX_COMMAND_LINE_BYTES,
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
