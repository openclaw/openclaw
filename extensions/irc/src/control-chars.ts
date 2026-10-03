export { containsAsciiControlCharacter as hasIrcControlChars } from "openclaw/plugin-sdk/string-coerce-runtime";

function isIrcControlChar(charCode: number): boolean {
  return charCode <= 0x1f || charCode === 0x7f;
}

export function stripIrcControlChars(value: string): string {
  let out = "";
  for (const char of value) {
    if (!isIrcControlChar(char.charCodeAt(0))) {
      out += char;
    }
  }
  return out;
}
