const fs = require("fs");
let code = fs.readFileSync("scripts/morning-report-data.ts", "utf8");

// Update TEAM
code = code.replace(
  'const TEAM: Record<number, string> = {\n  14206: "Sam",\n  14204: "Clay",\n  14205: "Daxton",\n};',
  'const TEAM: Record<number, string> = {\n  14206: "Sam",\n  14204: "Clay",\n  14205: "Daxton",\n  14649: "Kaleb T",\n  14884: "Junrey",\n};',
);

// Update byEmployee interface and structure
code = code.replace(
  "const byEmployee: Record<string, Array<{",
  "const byEmployee: Record<string, {\n    statusCounts: { Assigned: number, Working: number, Waiting: number, Total: number },\n    topWOs: Array<{",
);

code = code.replace(
  "for (const name of Object.values(TEAM)) {\n    byEmployee[name] = [];\n  }",
  "for (const name of Object.values(TEAM)) {\n    byEmployee[name] = { statusCounts: { Assigned: 0, Working: 0, Waiting: 0, Total: 0 }, topWOs: [] };\n  }",
);

// Update logic inside the loop
code = code
  .replace(
    "byEmployee[name].push({",
    'const sTitle = s.toLowerCase();\n    if (sTitle === "assigned") byEmployee[name].statusCounts.Assigned++;\n    else if (sTitle === "working") byEmployee[name].statusCounts.Working++;\n    else if (sTitle === "waiting") byEmployee[name].statusCounts.Waiting++;\n    byEmployee[name].statusCounts.Total++;\n\n    // Exclude Utility-dependent WOs from the actionable top list\n    if (wo.title.toLowerCase().includes("utility") || wo.title.toLowerCase().includes("nem application") || wo.title.toLowerCase().includes("interconnection")) continue;\n\n    byEmployee[name].topWOs.push({',
  )
  .replace(
    'const status = wo.status?.toLowerCase() ?? "";',
    'const status = wo.status?.toLowerCase() ?? "";\n    const s = wo.status ?? "Unknown";',
  );

// Adjust priority logic to include SLA
code = code.replace(
  'if (status === "assigned") priorityLabel = "HIGH";',
  'if (status === "assigned") priorityLabel = days > 5 ? "SLA" : "HIGH";\n    else if (status === "working") priorityLabel = days > 5 ? "SLA" : "MED";',
);
code = code.replace('priorityLabel = "LOW";', 'priorityLabel = days > 21 ? "SLA" : "LOW";');

// Sort logic fix
code = code.replace(
  "const priorityOrder: Record<string, number> = { HIGH: 0, MED: 1, LOW: 2, INFO: 3 };",
  "const priorityOrder: Record<string, number> = { SLA: 0, HIGH: 1, MED: 2, LOW: 3, INFO: 4 };",
);
code = code.replace(
  "byEmployee[name].sort((a, b) => {",
  "byEmployee[name].topWOs.sort((a, b) => {",
);
code = code.replace(
  "byEmployee[name] = byEmployee[name].slice(0, 5);",
  "byEmployee[name].topWOs = byEmployee[name].topWOs.slice(0, 5);",
);

// Email parsing updates for Kaleb T and Junrey
code = code.replace(
  "const daxton: Array<{ from: string; subject: string; date: string }> = [];",
  "const daxton: Array<{ from: string; subject: string; date: string }> = [];\n  const kalebt: Array<{ from: string; subject: string; date: string }> = [];\n  const junrey: Array<{ from: string; subject: string; date: string }> = [];",
);

code = code.replace(
  "return {\n    sam: sam.slice(0, 10),",
  "return {\n    sam: sam.slice(0, 10),\n    kalebt: kalebt.slice(0, 10),\n    junrey: junrey.slice(0, 10),",
);

code = code.replace(
  "daxton.push({ from: e.from, subject: e.subject, date: e.date });\n    }",
  'daxton.push({ from: e.from, subject: e.subject, date: e.date });\n    }\n\n    if (subjLower.includes("kaleb") || subjLower.includes("terranova") || (fromLower.includes("kaleb") && fromLower.includes("terranova"))) {\n      kalebt.push({ from: e.from, subject: e.subject, date: e.date });\n    }\n    if (subjLower.includes("junrey") || fromLower.includes("junrey")) {\n      junrey.push({ from: e.from, subject: e.subject, date: e.date });\n    }',
);

fs.writeFileSync("scripts/morning-report-data.ts", code);
