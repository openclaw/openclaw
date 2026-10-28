import fs from "node:fs";
import path from "node:path";
import { NPM_CLI_REPORT } from "./fs-safe-npm-cli-protocol.mjs";

try {
  const cli = fs.realpathSync(process.argv[1]);
  if (
    path.basename(cli) === "npm-cli.js" &&
    JSON.parse(fs.readFileSync(path.join(path.dirname(cli), "../package.json"), "utf8")).name ===
      "npm"
  ) {
    fs.writeFileSync(1, NPM_CLI_REPORT + JSON.stringify(cli) + "\n");
    process.exit(0);
  }
} catch {
  // The selected manager may invoke another process before reaching npm.
}
