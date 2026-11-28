// Writes the Control UI's English tool-row wording for the Apple apps, so the iPhone says what the web says.
// The web catalogs stay the owner; this file is generated from them.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { registerChatToolLabelsEnglish } from "../ui/src/i18n/locales/en-chat-tool-labels.ts";
import { registerChatToolOperationsEnglish } from "../ui/src/i18n/locales/en-chat-tool-operations.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputPath = path.join(
  repoRoot,
  "apps/shared/OpenClawKit/Sources/OpenClawKit/Resources/tool-operations.json",
);
const mode = process.argv[2];
if (mode !== "--check" && mode !== "--write") {
  console.error("Usage: node --import tsx scripts/tool-operations.ts --check|--write");
  process.exit(1);
}
const labels = {
  ...registerChatToolLabelsEnglish.catalog.chat.toolCards,
  ...registerChatToolOperationsEnglish.catalog.chat.toolCards,
};
const expected = `${JSON.stringify({ source: "ui/src/i18n/locales/en-chat-tool-operations.ts and en-chat-tool-labels.ts", labels }, null, 2)}\n`;
if (mode === "--write") {
  fs.writeFileSync(outputPath, expected);
  process.stdout.write(`wrote ${path.relative(repoRoot, outputPath)}\n`);
} else if (fs.readFileSync(outputPath, "utf8") !== expected) {
  console.error(
    "tool-operations.json is stale. Run: node --import tsx scripts/tool-operations.ts --write",
  );
  process.exit(1);
}
