import fs from "fs";

const usersData = JSON.parse(fs.readFileSync("/Users/vero/.openclaw/cache/ghl/users.json", "utf8"));
const userMap = {};
for (const u of usersData) {
  userMap[u.id] = u.name;
}

const appts = JSON.parse(
  fs.readFileSync("/Users/vero/.openclaw/cache/ghl/calendar-events.json", "utf8"),
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

for (const a of appts) {
  if (a.deleted || a.appointmentStatus === "cancelled" || a.appointmentStatus === "canceled") {
    continue;
  }
  const repName = userMap[a.assignedUserId];
  if (!repName) {
    continue;
  }
  if (counts[repName]) {
    const d = new Date(a.startTime);
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

for (const rep of reps) {
  console.log(`${rep} - Feb: ${counts[rep].feb}, Mar: ${counts[rep].mar}, Apr: ${counts[rep].apr}`);
}
