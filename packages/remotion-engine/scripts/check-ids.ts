import fs from "fs";
const t = fs.readFileSync("src/Compositions.generated.tsx", "utf8");
const ids = [...t.matchAll(/id: "([^"]+)"/g)].map((m) => m[1]);
console.log("count", ids.length, "unique", new Set(ids).size);
const dup = ids.filter((x, i) => ids.indexOf(x) !== i);
console.log("dups", [...new Set(dup)]);
console.log("first 5:", ids.slice(0, 5));
console.log("last 5:", ids.slice(-5));
