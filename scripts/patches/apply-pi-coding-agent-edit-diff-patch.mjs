/**
 * Apply patch to pi-coding-agent's edit-diff.js to fix error messages
 * when fuzzy matching is used.
 *
 * Issue: edit tool requires exact text match causing memory write failures
 * The edit tool has fuzzy matching but error messages say "exact text"
 * even when fuzzy was used.
 *
 * Usage: node scripts/patches/apply-pi-coding-agent-edit-diff-patch.mjs
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");

const EDIT_DIFF_PATH = path.join(
  ROOT,
  "node_modules/@mariozechner/pi-coding-agent/dist/core/tools/edit-diff.js"
);

// Patch content - replaces the error functions to include fuzzy match hints
const PATCHES = [
  {
    oldText: `function getNotFoundError(path, editIndex, totalEdits) {
    if (totalEdits === 1) {
        return new Error(\`Could not find the exact text in \${path}. The old text must match exactly including all whitespace and newlines.\`);
    }
    return new Error(\`Could not find edits[\${editIndex}] in \${path}. The oldText must match exactly including all whitespace and newlines.\`);
}`,
    newText: `function getNotFoundError(path, editIndex, totalEdits, usedFuzzyMatch) {
    const fuzzyHint = usedFuzzyMatch
        ? " (fuzzy matching was applied but the text was not found)"
        : "";
    if (totalEdits === 1) {
        return new Error(\`Could not find the text in \${path}. The old text must match exactly including all whitespace and newlines.\${fuzzyHint}\`);
    }
    return new Error(\`Could not find edits[\${editIndex}] in \${path}. The oldText must match exactly including all whitespace and newlines.\${fuzzyHint}\`);
}`,
  },
  {
    oldText: `function getDuplicateError(path, editIndex, totalEdits, occurrences) {
    if (totalEdits === 1) {
        return new Error(\`Found \${occurrences} occurrences of the text in \${path}. The text must be unique. Please provide more context to make it unique.\`);
    }
    return new Error(\`Found \${occurrences} occurrences of edits[\${editIndex}] in \${path}. Each oldText must be unique. Please provide more context to make it unique.\`);
}`,
    newText: `function getDuplicateError(path, editIndex, totalEdits, occurrences, usedFuzzyMatch) {
    const fuzzyHint = usedFuzzyMatch
        ? " (fuzzy matching normalized the text, causing multiple matches). Try including more surrounding context to make your oldText more specific."
        : "";
    if (totalEdits === 1) {
        return new Error(\`Found \${occurrences} occurrences of the text in \${path}. The text must be unique. Please provide more context to make it unique.\${fuzzyHint}\`);
    }
    return new Error(\`Found \${occurrences} occurrences of edits[\${editIndex}] in \${path}. Each oldText must be unique. Please provide more context to make it unique.\${fuzzyHint}\`);
}`,
  },
  {
    oldText: `        if (!matchResult.found) {
            throw getNotFoundError(path, i, normalizedEdits.length);
        }

        const occurrences = countOccurrences(baseContent, edit.oldText);
        if (occurrences > 1) {
            throw getDuplicateError(path, i, normalizedEdits.length, occurrences);
        }`,
    newText: `        if (!matchResult.found) {
            throw getNotFoundError(path, i, normalizedEdits.length, matchResult.usedFuzzyMatch);
        }

        const occurrences = countOccurrences(baseContent, edit.oldText);
        if (occurrences > 1) {
            throw getDuplicateError(path, i, normalizedEdits.length, occurrences, matchResult.usedFuzzyMatch);
        }`,
  },
];

function applyPatches() {
  if (!fs.existsSync(EDIT_DIFF_PATH)) {
    console.error(`Error: edit-diff.js not found at ${EDIT_DIFF_PATH}`);
    console.error("Run 'pnpm install' first to install dependencies.");
    process.exit(1);
  }

  let content = fs.readFileSync(EDIT_DIFF_PATH, "utf-8");
  let patched = false;

  for (const patch of PATCHES) {
    if (content.includes(patch.oldText)) {
      content = content.replace(patch.oldText, patch.newText);
      patched = true;
    } else {
      console.warn(`Warning: Could not find patch target in edit-diff.js`);
      console.warn(`Expected:\n${patch.oldText.slice(0, 200)}...`);
    }
  }

  if (patched) {
    fs.writeFileSync(EDIT_DIFF_PATH, content, "utf-8");
    console.log("Successfully applied patch to pi-coding-agent edit-diff.js");
    console.log("Error messages now indicate when fuzzy matching was used.");
  } else {
    console.log("No patches applied - edit-diff.js may already be patched or has unexpected content.");
  }
}

applyPatches();
