/**
 * Line-ending detection and restoration shared by the file-mutating agent tools.
 */

export function detectLineEnding(content: string): "\r\n" | "\n" {
  const crlfIdx = content.indexOf("\r\n");
  const lfIdx = content.indexOf("\n");
  if (lfIdx === -1) {
    return "\n";
  }
  if (crlfIdx === -1) {
    return "\n";
  }
  return crlfIdx < lfIdx ? "\r\n" : "\n";
}

export function normalizeToLF(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

const WINDOWS_BATCH_EXTENSION = /\.(?:bat|cmd)$/i;

/**
 * cmd.exe loses `goto`/`call` labels in LF-only scripts, so new batch file
 * content is written with CRLF. Other files keep the bytes the model sent.
 */
export function normalizeNewFileLineEndings(filePath: string, content: string): string {
  if (!WINDOWS_BATCH_EXTENSION.test(filePath)) {
    return content;
  }
  return content.replace(/\r\n|\r|\n/g, "\r\n");
}
