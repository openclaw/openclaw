// TEST FIXTURE: synthetic gate-free incumbent, NOT captured old production.
// Its only behaviors are a V1 field read and a loaded, FD9-less stdin wait.
import { readFileSync, writeSync } from "node:fs";
const [command, path, field] = process.argv.slice(2);
if (command === "journal-field") {
  process.stdout.write(String(JSON.parse(readFileSync(path, "utf8"))[field]) + "\n");
} else if (command === "wait-reader") {
  writeSync(1, "SYNTHETIC_READER_LOADED\n");
  readFileSync(0);
} else {
  throw new Error("unsupported synthetic old-reader command");
}
