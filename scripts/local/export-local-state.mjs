import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

function parseArgs(argv) {
  const args = {
    source: null,
    out: null,
    redactOut: null,
    includeAgents: false,
    includeLogs: false,
    includeMemory: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const cur = argv[i];
    if (cur === "--source") args.source = argv[++i] ?? null;
    else if (cur === "--out") args.out = argv[++i] ?? null;
    else if (cur === "--redact-out") args.redactOut = argv[++i] ?? null;
    else if (cur === "--include-agents") args.includeAgents = true;
    else if (cur === "--include-logs") args.includeLogs = true;
    else if (cur === "--include-memory") args.includeMemory = true;
    else if (cur === "--help" || cur === "-h") {
      args.help = true;
    } else if (cur?.startsWith("--")) {
      throw new Error(`Unknown flag: ${cur}`);
    }
  }
  return args;
}

function expandUserPath(input) {
  const trimmed = String(input ?? "").trim();
  if (!trimmed) return trimmed;
  if (trimmed.startsWith("~")) {
    return path.resolve(trimmed.replace(/^~(?=$|[\\/])/, os.homedir()));
  }
  return path.resolve(trimmed);
}

async function pathExists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

async function copyFileIfExists(from, to) {
  if (!(await pathExists(from))) return false;
  await ensureDir(path.dirname(to));
  await fs.copyFile(from, to);
  return true;
}

async function copyDirIfExists(fromDir, toDir, { filter } = {}) {
  if (!(await pathExists(fromDir))) return { copied: 0, skipped: 0 };
  await ensureDir(toDir);

  let copied = 0;
  let skipped = 0;

  const entries = await fs.readdir(fromDir, { withFileTypes: true });
  for (const entry of entries) {
    const src = path.join(fromDir, entry.name);
    const dst = path.join(toDir, entry.name);
    if (filter && !filter({ name: entry.name, src, isDir: entry.isDirectory() })) {
      skipped += 1;
      continue;
    }
    if (entry.isDirectory()) {
      const res = await copyDirIfExists(src, dst, { filter });
      copied += res.copied;
      skipped += res.skipped;
    } else if (entry.isFile()) {
      await ensureDir(path.dirname(dst));
      await fs.copyFile(src, dst);
      copied += 1;
    } else {
      skipped += 1;
    }
  }

  return { copied, skipped };
}

function shouldRedactKey(key) {
  const k = String(key).toLowerCase();
  return (
    k.includes("token") ||
    k.includes("secret") ||
    k.includes("password") ||
    k.includes("apikey") ||
    k.includes("api_key") ||
    k.endsWith("key")
  );
}

function redactValue(value) {
  if (typeof value === "string") {
    const trimmed = value.trim();
    // Telegram bot token format: <digits>:<base64url-ish>
    if (/^\d+:[A-Za-z0-9_-]{20,}$/.test(trimmed)) return "<redacted>";
    // Discord bot token-ish (very loose) or other opaque tokens
    if (trimmed.length >= 24 && /^[A-Za-z0-9._-]+$/.test(trimmed)) return "<redacted>";
    // Local absolute paths are usually personal; keep only basename.
    if (path.isAbsolute(trimmed) || trimmed.startsWith("~/")) {
      return `<path:${path.basename(trimmed)}>`;
    }
  }
  return "<redacted>";
}

function redactObject(obj) {
  if (Array.isArray(obj)) {
    // Lists often contain ids/handles; keep shape but hide contents.
    return obj.length > 0 ? ["<redacted>"] : [];
  }
  if (!obj || typeof obj !== "object") return obj;

  const out = {};
  for (const [key, value] of Object.entries(obj)) {
    if (shouldRedactKey(key)) {
      out[key] = redactValue(value);
      continue;
    }

    // Known id-heavy fields: keep presence but hide.
    if (key === "allowFrom" || key === "groupAllowFrom") {
      out[key] = Array.isArray(value) && value.length > 0 ? ["<redacted>"] : [];
      continue;
    }

    if (key === "groups" && value && typeof value === "object" && !Array.isArray(value)) {
      const v = value;
      const keep = {};
      if (Object.prototype.hasOwnProperty.call(v, "*")) keep["*"] = v["*"];
      const exampleKey = Object.keys(v).find((k) => k !== "*");
      if (exampleKey) keep["<redacted>"] = v[exampleKey];
      out[key] = keep;
      continue;
    }

    out[key] = redactObject(value);
  }
  return out;
}

async function readJsonFile(filePath) {
  const raw = await fs.readFile(filePath, "utf-8");
  try {
    return JSON.parse(raw);
  } catch {
    const json5 = await import("json5");
    return json5.default.parse(raw);
  }
}

async function writeJsonFile(filePath, value) {
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

function formatList(items) {
  return items.length ? items.map((v) => `- ${v}`).join("\n") : "- (none)";
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(
      [
        "Usage: node scripts/local/export-local-state.mjs [flags]",
        "",
        "Flags:",
        "  --source <dir>       Source state dir (default: ~/.moltbot)",
        "  --out <dir>          Output dir (default: ./.local/moltbot/state)",
        "  --redact-out <dir>   Write redacted snapshots here (default: ./config/redacted)",
        "  --include-agents     Copy ~/.moltbot/agents (can be large)",
        "  --include-memory     Copy ~/.moltbot/memory (can be large)",
        "  --include-logs       Copy ~/.moltbot/logs (can be large)",
        "",
      ].join("\n"),
    );
    return;
  }

  const source = expandUserPath(args.source ?? "~/.moltbot");
  const outDir = expandUserPath(args.out ?? path.join(process.cwd(), ".local", "moltbot", "state"));
  const redactOutDir = expandUserPath(
    args.redactOut ?? path.join(process.cwd(), "config", "redacted"),
  );

  if (!(await pathExists(source))) {
    throw new Error(`Source state dir not found: ${source}`);
  }

  await ensureDir(outDir);
  await ensureDir(redactOutDir);

  const copied = [];
  const missing = [];

  const configPath = path.join(source, "moltbot.json");
  if (await copyFileIfExists(configPath, path.join(outDir, "moltbot.json"))) copied.push("moltbot.json");
  else missing.push("moltbot.json");

  // Backups (helpful for diffing/migrations)
  const stateEntries = await fs.readdir(source, { withFileTypes: true });
  for (const entry of stateEntries) {
    if (!entry.isFile()) continue;
    if (!/^moltbot\.json\.bak(\.|$)/.test(entry.name) && !/^clawdbot\.json\.bak(\.|$)/.test(entry.name)) {
      continue;
    }
    await copyFileIfExists(path.join(source, entry.name), path.join(outDir, entry.name));
    copied.push(entry.name);
  }

  // Credentials: copy pairing + allowFrom stores only (avoid oauth.json).
  const credsSrc = path.join(source, "credentials");
  await copyDirIfExists(credsSrc, path.join(outDir, "credentials"), {
    filter: ({ name, isDir }) => {
      if (isDir) return true;
      return name.endsWith("-allowFrom.json") || name.endsWith("-pairing.json");
    },
  });
  if (await pathExists(credsSrc)) copied.push("credentials/*(-allowFrom|-pairing).json");

  // Telegram update offsets
  const tgSrc = path.join(source, "telegram");
  await copyDirIfExists(tgSrc, path.join(outDir, "telegram"), {
    filter: ({ name, isDir }) => isDir || name.startsWith("update-offset-"),
  });
  if (await pathExists(tgSrc)) copied.push("telegram/update-offset-*.json");

  // Optional large dirs
  if (args.includeAgents) {
    await copyDirIfExists(path.join(source, "agents"), path.join(outDir, "agents"));
    copied.push("agents/**");
  }
  if (args.includeMemory) {
    await copyDirIfExists(path.join(source, "memory"), path.join(outDir, "memory"));
    copied.push("memory/**");
  }
  if (args.includeLogs) {
    await copyDirIfExists(path.join(source, "logs"), path.join(outDir, "logs"));
    copied.push("logs/**");
  }

  // Redacted snapshot of config for version control.
  if (await pathExists(configPath)) {
    const cfg = await readJsonFile(configPath);
    const redacted = redactObject(cfg);
    await writeJsonFile(path.join(redactOutDir, "moltbot.redacted.json"), redacted);
  }

  process.stdout.write(
    [
      "Export complete.",
      "",
      `Source: ${source}`,
      `Out:    ${outDir}`,
      `Redact: ${redactOutDir}`,
      "",
      "Copied:",
      formatList(copied),
      "",
      "Missing:",
      formatList(missing),
      "",
      "Notes:",
      "- Out dir is under .local/ and is gitignored by default.",
      "- Redacted config snapshot is safe to commit; validate before pushing.",
      "",
    ].join("\n"),
  );
}

await main();

