import fs from "fs";

const reps = [
  "Tristan Masteller",
  "Jackson Godfrey",
  "Mateo Weeks",
  "Daniel Delis",
  "Nick Greene",
  "Landen Olsen",
  "Landen",
];

function countInFile(file, nameField, dateField) {
  if (!fs.existsSync(file)) {
    return;
  }
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  const arr = Array.isArray(data) ? data : data.opportunities || data.events || data.contacts || [];

  console.log(`\n--- ${file} ---`);
  for (const rep of reps) {
    let feb = 0,
      mar = 0,
      apr = 0;
    for (const p of arr) {
      const repStr = JSON.stringify(p).toLowerCase();
      if (repStr.includes(rep.toLowerCase().split(" ")[0])) {
        // Just matching first name roughly or stringifying
        // Find actual matches more reliably:
        if (repStr.includes(rep.toLowerCase())) {
          const dStr =
            p[dateField] || p.createdAt || p.dateAdded || p.startTime || p.startTimeStamp;
          if (!dStr) {
            continue;
          }
          const d = new Date(dStr);
          if (d.getFullYear() !== 2026) {
            continue;
          }
          const m = d.getMonth() + 1;
          if (m === 2) {
            feb++;
          }
          if (m === 3) {
            mar++;
          }
          if (m === 4) {
            apr++;
          }
        }
      }
    }
    if (feb > 0 || mar > 0 || apr > 0) {
      console.log(`${rep} - Feb: ${feb}, Mar: ${mar}, Apr: ${apr}`);
    }
  }
}

countInFile("/Users/vero/.openclaw/cache/ghl/opportunities.json", "assignedTo", "createdAt");
countInFile("/Users/vero/.openclaw/cache/ghl/calendar-events.json", "assignedTo", "startTime");
countInFile("/Users/vero/.openclaw/cache/ghl/contacts.json", "assignedTo", "dateAdded");
