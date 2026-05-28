import path from "node:path";

const OPENCLAW_SCRIPT_PREFIX_PATTERN =
  /\bpnpm\s+(?!(?:--dir|-C)\b)((?:capital-hft|capital|okx|autonomous|governance|tradingagents|dmad)[^\s`;&|]*)/gu;

function shellPath(value) {
  const resolved = path.resolve(String(value ?? process.cwd()));
  return /[\s"`;&|<>]/u.test(resolved) ? JSON.stringify(resolved) : resolved;
}

export function openclawPnpmCommand(repoRoot, scriptName, args = []) {
  const tokens = ["pnpm", "--dir", shellPath(repoRoot), String(scriptName ?? "").trim()].filter(
    Boolean,
  );
  for (const arg of args) {
    if (arg === null || arg === undefined || arg === "") {
      continue;
    }
    tokens.push(String(arg));
  }
  return tokens.join(" ");
}

export function qualifyOpenClawPnpmCommands(repoRoot, value) {
  if (typeof value === "string" && value.length > 0) {
    const commandPrefix = `pnpm --dir ${shellPath(repoRoot)} `;
    return value.replace(OPENCLAW_SCRIPT_PREFIX_PATTERN, `${commandPrefix}$1`);
  }
  if (Array.isArray(value)) {
    return value.map((item) => qualifyOpenClawPnpmCommands(repoRoot, item));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        qualifyOpenClawPnpmCommands(repoRoot, item),
      ]),
    );
  }
  if (typeof value !== "string" || value.length === 0) {
    return value;
  }
  return value;
}
