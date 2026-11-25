import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { readGlossary } from "./glossary.mjs";

// Input is extracted prose, never a source file containing code or literal evidence.
// The caller selects a glossary meaning rather than guessing the sense of a word.
export function checkCopy(text, meaning, entries = readGlossary()) {
  const findings = [];
  if (text.includes(";")) {
    findings.push("Use a period, conjunction, or rewrite instead of a semicolon.");
  }
  if (/…|\.{3}/u.test(text)) {
    findings.push("Remove the ellipsis. Loading punctuation cleanup does not add animation.");
  }
  if (meaning) {
    const entry = entries.find((row) => row.use === meaning);
    if (!entry) {
      throw new Error("Unknown glossary meaning: " + meaning);
    }
    for (const phrase of entry.avoid
      .replace(/\([^)]*\)/g, "")
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean)) {
      const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const caseOnly = phrase !== entry.use && phrase.toLowerCase() === entry.use.toLowerCase();
      if (
        new RegExp(
          "(?<![\\p{L}\\p{N}_])" + escaped + "(?![\\p{L}\\p{N}_])",
          caseOnly ? "u" : "iu",
        ).test(text)
      ) {
        findings.push("For " + entry.use + ", replace “" + phrase + "”. Meaning: " + entry.meaning);
      }
    }
  }
  return findings;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [input] = process.argv.slice(2);
  if (!input || process.argv.length !== 3) {
    console.error(
      "Usage: node .agents/skills/openclaw-writing/scripts/copy-check.mjs <extracted-copy.json>",
    );
    process.exitCode = 2;
  } else {
    const items = JSON.parse(readFileSync(input, "utf8"));
    if (!Array.isArray(items)) {
      throw new Error("Expected an array of { text, meaning? } records");
    }
    items.forEach((item, index) => {
      if (typeof item.text !== "string") {
        throw new Error("Expected text at item " + index);
      }
      const findings = checkCopy(item.text, item.meaning);
      if (findings.length) {
        console.log(JSON.stringify({ item: index, findings }));
        process.exitCode = 1;
      }
    });
  }
}
