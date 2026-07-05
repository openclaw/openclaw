import { sanitizeBinaryOutput } from "../src/agents/shell-utils.js";

// Reproduces the old sanitizer behavior for comparison: it drops every C0
// control byte except tab, newline, and carriage return.
function sanitizeBinaryOutputOld(text: string): string {
  const scrubbed = text.replace(/[\p{Format}\p{Surrogate}]/gu, "");
  if (!scrubbed) {
    return scrubbed;
  }
  const chunks: string[] = [];
  for (const char of scrubbed) {
    const code = char.codePointAt(0);
    if (code == null) {
      continue;
    }
    if (code === 0x09 || code === 0x0a || code === 0x0d) {
      chunks.push(char);
      continue;
    }
    if (code < 0x20) {
      continue;
    }
    chunks.push(char);
  }
  return chunks.join("");
}

// Simulated SSH banner / PTY output with ANSI color, cursor movement, window
// title OSC, BEL, and a NUL byte. This is representative of the output that was
// disappearing into an empty/image placeholder before the fix.
const terminalOutput = [
  "\x1b[0m\x1b[H\x1b[J", // reset / home / clear
  "\x1b[1;32mWelcome to the server\x1b[0m\x07\n",
  "\x1b]0;remote-host\x07", // window title OSC
  "\x1b[33mWarning\x1b[0m: disk usage at 85%\x00\n",
  "\x1b[?2004h", // bracketed paste enable
  "\x1b[1m> \x1b[0m",
].join("");

function visible(input: string): string {
  const esc = String.fromCharCode(0x1b);
  const bel = String.fromCharCode(0x07);
  const nul = String.fromCharCode(0x00);
  return input
    .split(esc)
    .join("\\x1b")
    .split(bel)
    .join("\\x07")
    .split(nul)
    .join("\\x00")
    .split("\n")
    .join("\\n\n");
}

console.log("=== Raw terminal output (control bytes visible) ===");
console.log(visible(terminalOutput));
console.log();

console.log("=== Old sanitizer (all C0 controls deleted) ===");
const oldResult = sanitizeBinaryOutputOld(terminalOutput);
console.log(`length=${oldResult.length}`);
console.log(oldResult || "(empty string -> binary/MIME placeholder fallback)");
console.log();

console.log("=== New sanitizer (ANSI/OSC stripped, residual controls escaped) ===");
const newResult = sanitizeBinaryOutput(terminalOutput);
console.log(`length=${newResult.length}`);
console.log(newResult);
console.log();

console.log("=== Verification ===");
console.log(`Old result length: ${oldResult.length}`);
console.log(`New result length: ${newResult.length}`);
console.log(
  `New result contains human-readable text: ${newResult.includes("Welcome to the server")}`,
);
console.log(`New result escapes NUL: ${newResult.includes("\\x00")}`);
console.log(`New result escapes BEL: ${newResult.includes("\\x07")}`);
console.log(`ANSI stripped: ${!newResult.includes("\x1b") && !newResult.includes("\\x1b[")}`);
