import fs from "fs";

const usersData = JSON.parse(fs.readFileSync("/Users/vero/.openclaw/cache/ghl/users.json", "utf8"));
const userMap = {};
for (const u of usersData.users || usersData) {
  userMap[u.id] = u.name;
}

const opps = JSON.parse(
  fs.readFileSync("/Users/vero/.openclaw/cache/ghl/opportunities.json", "utf8"),
);
const reps = [
  "Tristan Masteller",
  "Jackson Godfrey",
  "Mateo Weeks",
  "Daniel Delis",
  "Nick Greene",
  "Landen Olsen",
];
const counts = {};
for (const r of reps) {
  counts[r] = { feb: 0, mar: 0, apr: 0 };
}

let totalOpps = 0;
for (const o of opps.opportunities || opps) {
  totalOpps++;
  const repName = userMap[o.assignedTo];
  if (!repName) {
    continue;
  }
  if (counts[repName]) {
    const dStr = o.createdAt;
    if (!dStr) {
      continue;
    }
    const d = new Date(dStr);
    if (d.getFullYear() === 2026) {
      const m = d.getMonth() + 1;
      if (m === 2) {
        counts[repName].feb++;
      }
      if (m === 3) {
        counts[repName].mar++;
      }
      if (m === 4) {
        counts[repName].apr++;
      }
    }
  }
}

console.log("Total opps:", totalOpps);

for (const rep of reps) {
  console.log(`${rep} - Feb: ${counts[rep].feb}, Mar: ${counts[rep].mar}, Apr: ${counts[rep].apr}`);
}
