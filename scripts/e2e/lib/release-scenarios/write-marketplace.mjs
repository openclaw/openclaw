// Writes a marketplace fixture for release scenario E2E tests.
import path from "node:path";
import { writeJson } from "../fixtures/common.mjs";

const [root, alias, ...plugins] = process.argv.slice(2);

if (!root || !alias || plugins.length === 0) {
  throw new Error("usage: write-marketplace.mjs <root> <alias> <pluginId>...");
}

writeJson(path.join(root, ".claude-plugin", "marketplace.json"), {
  name: "Release Fixture Marketplace",
  version: "1.0.0",
  plugins: plugins.map((pluginId) => ({
    name: pluginId,
    version: "0.0.1",
    description: `${pluginId} release fixture`,
    source: { type: "path", path: `./plugins/${pluginId}` },
  })),
});
writeJson(path.join(process.env.HOME, ".claude", "plugins", "known_marketplaces.json"), {
  [alias]: {
    installLocation: root,
    source: { type: "github", repo: "openclaw/release-fixture-marketplace" },
  },
});
