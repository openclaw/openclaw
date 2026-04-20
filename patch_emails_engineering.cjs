const fs = require("fs");
let code = fs.readFileSync("scripts/morning-report-data.ts", "utf8");

// Add execSync import if not present
if (!code.includes("execSync")) {
  code = code.replace(
    'import { readFileSync, writeFileSync, existsSync } from "node:fs";',
    'import { readFileSync, writeFileSync, existsSync } from "node:fs";\nimport { execSync } from "node:child_process";',
  );
}

// 1. Fetch Customer Name for CenterPoint emails
const emailBodyPatch = `    // Daxton: utility interconnection, PTO, meter
    if (
      subjLower.includes("interconnection") ||
      subjLower.includes("pto") ||
      subjLower.includes("meter set") ||
      subjLower.includes("utility") ||
      (fromLower.includes("permitting@veropwr") && (
        subjLower.includes("interconnection") ||
        subjLower.includes("utility") ||
        subjLower.includes("pto")
      ))
    ) {
      let subj = e.subject;
      if (fromLower.includes("centerpointenergy")) {
        try {
          const out = execSync(\`gog gmail get \${e.id} -a jr@veropwr.com -j\`, { encoding: 'utf8' });
          const data = JSON.parse(out);
          const match = data.body?.match(/Customer Name:.*?<td[^>]*>.*?<span>(?:&nbsp;)?(.*?)</is);
          if (match && match[1]) {
            subj += \` (\${match[1].trim()})\`;
          }
        } catch (err) {}
      }
      daxton.push({ from: e.from, subject: subj, date: e.date });
    }`;

code = code.replace(
  /    \/\/ Daxton: utility interconnection, PTO, meter\s+if \([\s\S]*?daxton\.push\(\{ from: e\.from, subject: e\.subject, date: e\.date \}\);\s+\}/,
  emailBodyPatch,
);

// 2. Filter Kaleb T Plan Reviews based on Engineering completion
const engineeringPatch = `  // Pre-calculate which projects have completed engineering
  const projectEngStatus = new Map<number, boolean>();
  for (const w of wos) {
    if (!w.project?.id) continue;
    if (w.title.toLowerCase().includes("engineering")) {
       const isComplete = w.status?.toLowerCase() === "completed";
       // If we already saw an incomplete one, don't overwrite with complete unless we want to?
       // Let's say if ANY engineering WO is NOT completed, then engineering is not completed.
       const existing = projectEngStatus.get(w.project.id);
       if (existing === undefined) {
         projectEngStatus.set(w.project.id, isComplete);
       } else {
         projectEngStatus.set(w.project.id, existing && isComplete);
       }
    }
  }

  const open = wos.filter`;

code = code.replace("  const open = wos.filter", engineeringPatch);

const kalebPatch = `    // Exclude Utility-dependent WOs from the actionable top list
    if (wo.title.toLowerCase().includes("utility") || wo.title.toLowerCase().includes("nem application") || wo.title.toLowerCase().includes("interconnection")) continue;

    if (name === "Kaleb T" && wo.title.toLowerCase().includes("plan review")) {
      const engComplete = projectEngStatus.get(wo.project?.id ?? -1);
      // If engineering is explicitly not completed (exists and is false), skip it
      if (engComplete === false) continue;
    }`;

code = code.replace(
  '    // Exclude Utility-dependent WOs from the actionable top list\n    if (wo.title.toLowerCase().includes("utility") || wo.title.toLowerCase().includes("nem application") || wo.title.toLowerCase().includes("interconnection")) continue;',
  kalebPatch,
);

fs.writeFileSync("scripts/morning-report-data.ts", code);
