const fs = require("fs");
let code = fs.readFileSync("scripts/morning-report-data.ts", "utf8");
code = code.replace(
  `  const byEmployee: Record<string, {\n    statusCounts: { Assigned: number, Working: number, Waiting: number, Total: number },\n    topWOs: Array<{\n    id: number;\n    title: string;\n    project: string;\n    status: string;\n    daysInStatus: number;\n    openChecklist: string[];\n    priority: string;\n  }>> = {};`,
  `  const byEmployee: Record<string, {\n    statusCounts: { Assigned: number, Working: number, Waiting: number, Total: number },\n    topWOs: Array<{\n      id: number;\n      title: string;\n      project: string;\n      status: string;\n      daysInStatus: number;\n      openChecklist: string[];\n      priority: string;\n    }>\n  }> = {};`,
);
fs.writeFileSync("scripts/morning-report-data.ts", code);
