import fs from "fs";
const data = JSON.parse(
  fs.readFileSync("/Users/vero/.openclaw/cache/coperniq/projects.json", "utf8"),
);
const reps = [
  "Tristan Masteller",
  "Jackson Godfrey",
  "Mateo Weeks",
  "Daniel Delis",
  "Nick Greene",
  "Landen Olsen",
  "Landen",
];
for (const rep of reps) {
  let feb = 0,
    mar = 0,
    apr = 0;
  for (const p of data) {
    const ownerName = p.owner?.firstName + " " + p.owner?.lastName;
    const salesRepName = p.salesRep?.firstName + " " + p.salesRep?.lastName;
    if (ownerName.includes(rep) || salesRepName.includes(rep)) {
      const m = new Date(p.createdAt).getMonth() + 1;
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
  if (feb > 0 || mar > 0 || apr > 0) {
    console.log(`${rep} - Feb: ${feb}, Mar: ${mar}, Apr: ${apr}`);
  }
}
