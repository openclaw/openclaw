import { shellEscape } from "openclaw/plugin-sdk/sandbox";

// Tenki's exec API rejects empty argv elements (protovalidate min_len: 1),
// but fs-bridge scripts legitimately pass "" positionals. Inline them with
// `set --` and shell quoting so empty strings survive as ''.
export function buildPositionalArgsPrefix(args: readonly string[] | undefined): string {
  if (!args || args.length === 0) {
    return "";
  }
  return `set -- ${args.map((arg) => shellEscape(arg)).join(" ")}\n`;
}
