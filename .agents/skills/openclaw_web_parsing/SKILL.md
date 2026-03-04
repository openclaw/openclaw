---
name: OpenClaw Web Parsing Flow
description: "How to use the openclaw browser to navigate pages, capture snapshots, and extract data such as paragraphs from DOM structures instead of evaluating execution code."
---

# Instruction for OpenClaw Web Parsing Flow

This skill provides a standard and reliable method for automating multi-page data extraction using the `openclaw browser` CLI tools.

## Objective
Extract repetitive text structures (e.g., chapters or paragraphs) from a web page and navigate automatically to consecutive pages. 

## Best Practices
1. **Prefer `snapshot` over `evaluate`**: Executing scripts with `evaluate` directly in terminals can cause string interpolation, base64 decoding, or parsing syntax errors. The `openclaw browser snapshot` command generates the Accessibility/DOM tree. It is robust and provides `ref` identifiers that make text node extraction reliable.
2. **Retrieve `refs` for interaction**: When you parse the `snapshot` CLI text output, search for elements such as links and store their `[ref=\d+|-a-z]+` values.
3. **Use `click <ref>` for navigation**: Use the standard `openclaw browser click <ref>` using the extracted element's reference ID.
4. **Use `pdf` for debug points**: Emitting `openclaw browser pdf` helps as a checkpoint to view what the page currently looks like prior to capturing the snapshot or parsing.

## Flow Execution Example

Here's how to structure a Node.js utility script (`downloader.mjs`) using `child_process.execSync` to run openclaw CLI tools:

```javascript
import { execSync } from 'child_process';
import { appendFileSync } from 'fs';

function run(cmd) {
    return execSync(cmd, { encoding: 'utf8', stdio: 'pipe' });
}

async function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

async function extractChapters() {
    for (let i = 0; i < 3; i++) {
        const snapshotRaw = run(`node scripts/run-node.mjs browser snapshot`);
        const lines = snapshotRaw.split('\\n');
        
        let paragraphs = [];
        let nextChapterRef = null;

        for (const line of lines) {
            // Match any standard paragraph tag element
            const pMatch = line.match(/^\\s*-\\s*paragraph\\s*(?:\\[ref=([^\]]+)\\])?:\\s*(.*)$/);
            if (pMatch) paragraphs.push(pMatch[2].trim());

            // Match Next Chapter navigation button
            const nextMatch = line.match(/^.*link\\s+"[^"]*Next Chapter[^"]*"\\s*\\[ref=([^\]]+)\\].*/i);
            if (nextMatch && !nextChapterRef) nextChapterRef = nextMatch[1];
        }

        // Output parsing
        const chapterText = paragraphs.join('\\n\\n');
        appendFileSync("paragraphs_out.txt", `\\n\\n--- Chapter ---\\n\\n\\n${chapterText}\\n\\n`);

        if (nextChapterRef) {
            // Automate clicking 
            run(`node scripts/run-node.mjs browser click ${nextChapterRef}`);
            await sleep(5000); // Important to wait for the new page load
        } else {
            console.log("No Next Chapter found.");
            break;
        }
    }
}

extractChapters();
```

## When To Use
Run this node execution script or implement parts of this workflow whenever the objective requires saving reading content (books, comics text, forum thread posts) that span multiple pages incrementally using `openclaw browser`. 
