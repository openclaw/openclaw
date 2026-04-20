import fs from "fs";

const now = new Date();
const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

const wos = JSON.parse(
  fs.readFileSync("/Users/vero/.openclaw/cache/coperniq/work-orders.json", "utf8"),
);

const targets = {
  "Sam LeSueur": { total: 0, completed: 0, pending: 0 },
  "Jordan Evans": { total: 0, completed: 0, pending: 0 },
  "Clay Neser": { total: 0, completed: 0, pending: 0 },
};

for (const wo of wos) {
  const assignee = wo.assignee?.firstName + " " + wo.assignee?.lastName;
  const woDate = new Date(wo.createdAt || wo.updatedAt);
  if (woDate > thirtyDaysAgo) {
    let nameMatch = null;
    if (assignee?.toLowerCase().includes("sam")) {
      nameMatch = "Sam LeSueur";
    }
    if (assignee?.toLowerCase().includes("jordan")) {
      nameMatch = "Jordan Evans";
    }
    if (assignee?.toLowerCase().includes("clay")) {
      nameMatch = "Clay Neser";
    }

    if (nameMatch) {
      targets[nameMatch].total++;
      if (wo.isCompleted || wo.status === "Completed") {
        targets[nameMatch].completed++;
      } else {
        targets[nameMatch].pending++;
      }
    }
  }
}

for (const [name, stats] of Object.entries(targets)) {
  const rate = stats.total > 0 ? Math.round((stats.completed / stats.total) * 100) : 0;
  let grade = "F";
  if (rate >= 95) {
    grade = "A";
  } else if (rate >= 90) {
    grade = "B";
  } else if (rate >= 80) {
    grade = "C";
  } else if (rate >= 70) {
    grade = "D";
  }

  console.log(`${name}:
  Total WOs (30 days): ${stats.total}
  Completed: ${stats.completed}
  Pending/Assigned: ${stats.pending}
  Completion Rate: ${rate}%
  Coperniq Grade Est: ${grade}
  `);
}
