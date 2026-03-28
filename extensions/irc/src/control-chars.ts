export function isIrcControlChar(charCode: number): boolean {
  // 0x0a is newline - preserve for draft/multiline support
  return (charCode <= 0x1f || charCode === 0x7f) && charCode !== 0x0a;
}

export function hasIrcControlChars(value: string): boolean {
  for (const char of value) {
    if (isIrcControlChar(char.charCodeAt(0))) {
      return true;
    }
  }
  return false;
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
