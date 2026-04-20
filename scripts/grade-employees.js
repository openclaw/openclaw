import fs from "fs";
import os from "os";
import path from "path";

const REPO_ROOT = path.join(path.dirname(new URL(import.meta.url).pathname), "..");
const CACHE_DIR = path.join(os.homedir(), ".openclaw", "cache");
const COPERNIQ_CACHE = path.join(CACHE_DIR, "coperniq");
const EMAIL_ARCHIVE = path.join(REPO_ROOT, "email-archive", "emails.json");

const EXCLUDED_STATUSES = new Set(["ON_HOLD", "WAITING", "CANCELLED"]);
const MS_IN_DAY = 1000 * 60 * 60 * 24;

function loadJson(filePath, required = true) {
  try {
    if (!fs.existsSync(filePath)) {
      if (required) {
        console.error(`Error: Required file not found at ${filePath}`);
      }
      return null;
    }
    const fileData = fs.readFileSync(filePath, "utf8");
    return JSON.parse(fileData);
  } catch (error) {
    console.error(`Error reading or parsing JSON file at ${filePath}: ${error.message}`);
    return null;
  }
}

async function main() {
  const allUsers = loadJson(path.join(COPERNIQ_CACHE, "users.json"));
  const allWorkOrders = loadJson(path.join(COPERNIQ_CACHE, "work-orders.json"));
  const allProjects = loadJson(path.join(COPERNIQ_CACHE, "projects.json"));
  // Load the old email format, which is a flat list under the 'messages' key
  const emailArchive = loadJson(EMAIL_ARCHIVE);

  if (!allUsers || !allWorkOrders || !allProjects || !emailArchive || !emailArchive.messages) {
    console.error("Failed to load one or more required data files. Aborting.");
    process.exit(1);
  }

  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

  const employeeStats = allUsers.reduce((acc, user) => {
    if (user.email) {
      acc[user.email.toLowerCase()] = {
        name: `${user.firstName} ${user.lastName}`,
        workOrders: { total: 0, completed: 0, excluded: 0 },
        woStatusDurations: { totalDays: 0, statusCount: 0 },
        emailsSent: 0,
      };
    }
    return acc;
  }, {});

  const excludedProjectIds = new Set(
    allProjects.filter((p) => EXCLUDED_STATUSES.has(p.status?.toUpperCase())).map((p) => p.id),
  );

  // 1. Process Work Orders and their Status Durations
  for (const wo of allWorkOrders) {
    const assigneeEmail = wo.assignee?.email?.toLowerCase();
    if (!assigneeEmail || !employeeStats[assigneeEmail]) {
      continue;
    }
    if (new Date(wo.updatedAt) < thirtyDaysAgo) {
      continue;
    }

    const stats = employeeStats[assigneeEmail];

    if (
      EXCLUDED_STATUSES.has(wo.status?.toUpperCase()) ||
      (wo.project && excludedProjectIds.has(wo.project.id))
    ) {
      stats.workOrders.excluded++;
      continue;
    }

    stats.workOrders.total++;
    if (wo.isCompleted) {
      stats.workOrders.completed++;
    }

    if (wo.statuses && Array.isArray(wo.statuses)) {
      for (const status of wo.statuses) {
        if (status.startedAt && status.endedAt) {
          if (new Date(status.endedAt) > thirtyDaysAgo) {
            const durationDays =
              (new Date(status.endedAt) - new Date(status.startedAt)) / MS_IN_DAY;
            stats.woStatusDurations.totalDays += durationDays;
            stats.woStatusDurations.statusCount++;
          }
        }
      }
    }
  }

  // 2. Process Emails (Volume only)
  for (const email of emailArchive.messages) {
    if (new Date(email.date) < thirtyDaysAgo) {
      continue;
    }
    const fromEmailMatch = email.from.match(/<(.+)>/);
    const fromEmail = (fromEmailMatch ? fromEmailMatch[1] : email.from).toLowerCase();
    if (employeeStats[fromEmail]) {
      employeeStats[fromEmail].emailsSent++;
    }
  }

  // 3. Calculate Scores and Grades
  const results = [];
  for (const email in employeeStats) {
    const stats = employeeStats[email];
    stats.avgDaysPerWOStatus =
      stats.woStatusDurations.statusCount > 0
        ? stats.woStatusDurations.totalDays / stats.woStatusDurations.statusCount
        : 0;
    results.push({ email, ...stats });
  }

  const maxEmails = Math.max(1, ...results.map((r) => r.emailsSent));
  const minAvgWOStatusDays = Math.min(
    ...results.filter((r) => r.avgDaysPerWOStatus > 0).map((r) => r.avgDaysPerWOStatus),
    30,
  );

  console.log("--- 30-Day Work Order Performance Grades ---");
  console.log("Scoring: 50% Completion, 30% WO Speed, 20% Email Volume\n");

  const finalResults = results.map((stats) => {
    const woScore =
      (stats.workOrders.total > 0 ? stats.workOrders.completed / stats.workOrders.total : 0) * 100;
    const woSpeedScore =
      (stats.avgDaysPerWOStatus > 0 ? minAvgWOStatusDays / stats.avgDaysPerWOStatus : 0) * 100;
    const emailScore = (stats.emailsSent / maxEmails) * 100;

    const finalScore = woScore * 0.5 + woSpeedScore * 0.3 + emailScore * 0.2;

    let grade = "F";
    if (finalScore >= 90) {
      grade = "A";
    } else if (finalScore >= 80) {
      grade = "B";
    } else if (finalScore >= 70) {
      grade = "C";
    } else if (finalScore >= 60) {
      grade = "D";
    }

    return { ...stats, finalScore: finalScore.toFixed(1), grade };
  });

  finalResults.sort((a, b) => b.finalScore - a.finalScore);

  for (const res of finalResults) {
    if (res.workOrders.total > 0 || res.emailsSent > 0) {
      console.log(
        `${res.name}:
  - Grade: ${res.grade} (Score: ${res.finalScore})
  - WOs: ${res.workOrders.completed}/${res.workOrders.total} | Avg Status Speed: ${res.avgDaysPerWOStatus.toFixed(1)} days | Emails: ${res.emailsSent}
`,
      );
    }
  }
}

void main();
