import { spawn } from "node:child_process";

function sanitizeBuffer(input) {
  const out = Buffer.allocUnsafe(input.length);
  for (let i = 0; i < input.length; i++) {
    const b = input[i];
    // Keep: tab/newline/carriage return + printable ASCII; replace everything else.
    out[i] = b === 9 || b === 10 || b === 13 || (b >= 32 && b <= 126) ? b : 63;
  }
  return out;
}

const [command, ...args] = process.argv.slice(2);
if (!command) {
  process.stderr.write(
    "Usage: node scripts/ci-sanitize-output.mjs <cmd> [args...]\n",
  );
  process.exit(2);
}

const child = spawn(command, args, {
  stdio: ["ignore", "pipe", "pipe"],
  shell: process.platform === "win32",
});

child.stdout.on("data", (chunk) => {
  process.stdout.write(sanitizeBuffer(Buffer.from(chunk)));
});

child.stderr.on("data", (chunk) => {
  process.stderr.write(sanitizeBuffer(Buffer.from(chunk)));
});

child.on("exit", (code, signal) => {
  if (signal) process.exit(1);
  process.exit(code ?? 1);
});
