import fs from "fs";

const usersData = JSON.parse(fs.readFileSync("/Users/vero/.openclaw/cache/ghl/users.json", "utf8"));
const userMap = {};
let count = 0;
for (const u of usersData.users || usersData) {
  userMap[u.id] = u.name;
  count++;
}

console.log("Users:", count);

const appts = JSON.parse(
  fs.readFileSync("/Users/vero/.openclaw/cache/ghl/calendar-events.json", "utf8"),
);
console.log("Appts:", appts.length || appts.events?.length);

for (const a of appts.events || appts) {
  if (a.deleted || a.appointmentStatus === "cancelled" || a.appointmentStatus === "canceled") {
    continue;
  }
  const repName = userMap[a.assignedUserId] || "Unknown";
  if (
    repName.includes("Landen") ||
    repName.includes("Tristan") ||
    repName.includes("Mateo") ||
    repName.includes("Daniel") ||
    repName.includes("Jackson") ||
    repName.includes("Nick Greene")
  ) {
    const d = new Date(a.startTime);
    if (d.getFullYear() === 2026) {
      console.log(repName, a.startTime);
      break;
    }
  }
}
