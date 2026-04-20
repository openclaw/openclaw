const fs = require("fs");
let code = fs.readFileSync("scripts/morning-report-data.ts", "utf8");

const custEmailPatch = `    // Customer emails: NOT from internal or known automated systems
    const isCustomer = !fromLower.includes("@veropwr.com") && 
                       !fromLower.includes("@coperniq.io") && 
                       !fromLower.includes("@luxfinancial.io") && 
                       !fromLower.includes("anbetrack") && 
                       !fromLower.includes("powerclerk") &&
                       !fromLower.includes("mygovernmentonline");

    if (isCustomer) {
      sam.push({ from: e.from, subject: "[CUSTOMER] " + e.subject, date: e.date });
      junrey.push({ from: e.from, subject: "[CUSTOMER] " + e.subject, date: e.date });
    }

    if (subjLower.includes("kaleb") || subjLower.includes("terranova") || (fromLower.includes("kaleb") && fromLower.includes("terranova"))) {`;

code = code.replace(
  '    if (subjLower.includes("kaleb") || subjLower.includes("terranova") || (fromLower.includes("kaleb") && fromLower.includes("terranova"))) {',
  custEmailPatch,
);

const veroficationPatch = `    if (name === "Kaleb T" && wo.title.toLowerCase().includes("plan review")) {
      const engComplete = projectEngStatus.get(wo.project?.id ?? -1);
      // If engineering is explicitly not completed (exists and is false), skip it
      if (engComplete === false) continue;
    }

    // Junrey oversees Verofication - surface these to him even if assigned to others
    if (wo.title.toLowerCase().includes("verofication") && name !== "Junrey") {
      byEmployee["Junrey"].statusCounts.Total++;
      byEmployee["Junrey"].statusCounts[sTitle === "assigned" ? "Assigned" : sTitle === "working" ? "Working" : "Waiting"]++;
      byEmployee["Junrey"].topWOs.push({
        id: wo.id,
        title: wo.title,
        project: wo.project?.title ?? "Unknown",
        status: wo.status,
        daysInStatus: days,
        openChecklist: openChecklist(wo),
        priority: priorityLabel,
      });
    }`;

code = code.replace(
  `    if (name === "Kaleb T" && wo.title.toLowerCase().includes("plan review")) {
      const engComplete = projectEngStatus.get(wo.project?.id ?? -1);
      // If engineering is explicitly not completed (exists and is false), skip it
      if (engComplete === false) continue;
    }`,
  veroficationPatch,
);

fs.writeFileSync("scripts/morning-report-data.ts", code);
