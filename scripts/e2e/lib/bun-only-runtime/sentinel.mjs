import fs from "node:fs";
import path from "node:path";

export const nodeLaunchers = ["node", "nodejs", "npm", "npx", "pnpm", "pnpx", "yarn", "corepack"];

const launcherToken = new RegExp(
  `(?:^|[\\s;&|()<>'"\`=])((?:[^\\s;&|()<>'"\`=]*/)?(?:${nodeLaunchers.join("|")}))(?=[\\s;&|()<>'"\`]|$)`,
  "g",
);

/**
 * Node launcher tokens in shell text, bare or path-qualified (`node`, "/opt/node/bin/node").
 * @param {string} text
 * @returns {string[]}
 */
export function findLauncherTokens(text) {
  return Array.from(text.matchAll(launcherToken), (match) => match[1]);
}

/** @param {string} value */
function shellQuote(value) {
  return "'" + value.replaceAll("'", "'\\''") + "'";
}

/**
 * Write the Linux sentinel prototype with its ledger destination baked in.
 * @param {string} binDir
 * @param {string} ledgerPath
 * @param {string[]} names
 */
export function writeNodeSentinels(binDir, ledgerPath, names = nodeLaunchers) {
  fs.mkdirSync(binDir, { recursive: true });
  const script = `#!/bin/sh
# OpenClaw Bun-only smoke: stand-in for a Node executable. Records the attempt, then fails.
ledger=${shellQuote(ledgerPath)}
b64() { printf '%s' "$1" | /usr/bin/base64 | /usr/bin/tr -d '\\n'; }
argv=''
for arg in "$@"; do argv="$argv\${argv:+,}\\"$(b64 "$arg")\\""; done
ancestors=''
pid=$PPID
depth=0
while [ "$depth" -lt 6 ] && [ -n "$pid" ] && [ "$pid" -gt 1 ] 2>/dev/null; do
  if [ -r "/proc/$pid/cmdline" ]; then
    cmd=$(/usr/bin/base64 <"/proc/$pid/cmdline" | /usr/bin/tr -d '\\n')
    next=$(/usr/bin/awk '{print $4}' "/proc/$pid/stat" 2>/dev/null)
  else
    cmd=$(/bin/ps -o args= -p "$pid" 2>/dev/null | /usr/bin/base64 | /usr/bin/tr -d '\\n')
    next=$(/bin/ps -o ppid= -p "$pid" 2>/dev/null | /usr/bin/tr -d ' ')
  fi
  ancestors="$ancestors\${ancestors:+,}{\\"pid\\":$pid,\\"cmdline\\":\\"$cmd\\"}"
  pid=$next
  depth=$((depth + 1))
done
line="{\\"v\\":1,\\"name\\":\\"$(b64 "\${0##*/}")\\",\\"exe\\":\\"$(b64 "$0")\\",\\"pid\\":$$,\\"ppid\\":$PPID,\\"cwd\\":\\"$(b64 "$PWD")\\",\\"argv\\":[$argv],\\"ancestors\\":[$ancestors]}"
printf '%s\\n' "$line" >>"$ledger"
printf '%s\\n' "openclaw bun-only smoke: \${0##*/} is not available in a Bun-only install (attempt recorded)" >&2
exit 127
`;
  for (const name of names) {
    const destination = path.join(binDir, name);
    fs.writeFileSync(destination, script, { mode: 0o755 });
    fs.chmodSync(destination, 0o755);
  }
}

if (import.meta.main) {
  writeNodeSentinels(process.argv[2], process.argv[3]);
}

/**
 * Decode shell records. argv contains arguments only; name is the executable.
 * index is the zero-based record offset used to associate records with steps.
 * @param {string} ledgerPath
 */
export function readSentinelLedger(ledgerPath) {
  let source;
  try {
    source = fs.readFileSync(ledgerPath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
  const decode = (value) => Buffer.from(value, "base64").toString("utf8");
  return source
    .split("\n")
    .filter(Boolean)
    .map((line, index) => {
      const record = JSON.parse(line);
      return {
        v: record.v,
        index,
        name: decode(record.name),
        // $0 is the exact path that was executed (PATH sentinel or a masked absolute fallback).
        exe: typeof record.exe === "string" ? decode(record.exe) : undefined,
        pid: record.pid,
        ppid: record.ppid,
        cwd: decode(record.cwd),
        argv: record.argv.map(decode),
        ancestors: record.ancestors.map((ancestor) => ({
          pid: ancestor.pid,
          cmdline: decode(ancestor.cmdline),
        })),
      };
    });
}
