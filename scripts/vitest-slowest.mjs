import fs from "node:fs";
import path from "node:path";

function parseArgs(argv) {
  const out = {
    dir: "",
    top: 50,
    outFile: "",
  };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dir") {
      out.dir = argv[i + 1] ?? "";
      i += 1;
      continue;
    }
    if (arg === "--top") {
      out.top = Number.parseInt(argv[i + 1] ?? "", 10);
      if (!Number.isFinite(out.top) || out.top <= 0) {
        out.top = 50;
      }
      i += 1;
      continue;
    }
    if (arg === "--out") {
      out.outFile = argv[i + 1] ?? "";
      i += 1;
      continue;
    }
  }
  return out;
}

function readJson(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  return JSON.parse(raw);
}

function toMs(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 0;
  }
  return value;
}

function safeRel(baseDir, filePath) {
  try {
    const rel = path.relative(baseDir, filePath);
    return rel.startsWith("..") ? filePath : rel;
  } catch {
    return filePath;
  }
}

function main() {
  const args = parseArgs(process.argv);
  const dir = args.dir?.trim();
  if (!dir) {
    console.error(
      "usage: node scripts/vitest-slowest.mjs --dir <reportDir> [--top 50] [--out out.md]",
    );
    process.exit(2);
  }
  if (!fs.existsSync(dir)) {
    console.error(`vitest report dir not found: ${dir}`);
    process.exit(2);
  }

  const entries = fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => path.join(dir, name));
  if (entries.length === 0) {
    console.error(`no vitest json reports in ${dir}`);
    process.exit(2);
  }

  const fileRows = [];
  const testRows = [];

  for (const filePath of entries) {
    let payload;
    try {
      payload = readJson(filePath);
    } catch (err) {
      fileRows.push({
        kind: "report",
        name: safeRel(dir, filePath),
        ms: 0,
        note: `failed to parse: ${String(err)}`,
      });
      continue;
    }
    const suiteResults = Array.isArray(payload.testResults) ? payload.testResults : [];
    for (const suite of suiteResults) {
      const suiteName = typeof suite?.name === "string" ? suite.name : "(unknown)";
      const startTime = toMs(suite?.startTime);
      const endTime = toMs(suite?.endTime);
      const suiteMs = Math.max(0, endTime - startTime);
      fileRows.push({
        kind: "file",
        name: safeRel(process.cwd(), suiteName),
        ms: suiteMs,
        note: safeRel(dir, filePath),
      });

      const assertions = Array.isArray(suite?.assertionResults) ? suite.assertionResults : [];
      for (const assertion of assertions) {
        const title = typeof assertion?.title === "string" ? assertion.title : "(unknown)";
        const duration = toMs(assertion?.duration);
        testRows.push({
          name: `${safeRel(process.cwd(), suiteName)} :: ${title}`,
          ms: duration,
          suite: safeRel(process.cwd(), suiteName),
          title,
        });
      }
    }
  }

  fileRows.sort((a, b) => b.ms - a.ms);
  testRows.sort((a, b) => b.ms - a.ms);

  const topFiles = fileRows.slice(0, args.top);
  const topTests = testRows.slice(0, args.top);

  const lines = [];
  lines.push(`# Vitest Slowest (${new Date().toISOString()})`);
  lines.push("");
  lines.push(`Reports: ${entries.length}`);
  lines.push("");
  lines.push("## Slowest Files");
  lines.push("");
  lines.push("| ms | file | report |");
  lines.push("|---:|:-----|:-------|");
  for (const row of topFiles) {
    lines.push(`| ${Math.round(row.ms)} | \`${row.name}\` | \`${row.note}\` |`);
  }
  lines.push("");
  lines.push("## Slowest Tests");
  lines.push("");
  lines.push("| ms | test |");
  lines.push("|---:|:-----|");
  for (const row of topTests) {
    lines.push(`| ${Math.round(row.ms)} | \`${row.name}\` |`);
  }
  lines.push("");
  lines.push(
    `Notes: file times are (endTime-startTime) per suite; test times come from assertion duration (may exclude setup/import).`,
  );
  lines.push("");

  const outText = lines.join("\n");
  if (args.outFile?.trim()) {
    fs.writeFileSync(args.outFile, outText, "utf8");
  }
  process.stdout.write(outText);
}

main();
