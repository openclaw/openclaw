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

You can now use the restored `scripts/run-node.js` CLI to capture indexed snapshots and automate interactions. This tool connects to the relay and produces a text-based tree where each interactive element has a reference index (e.g., `[e001]`).

```javascript
import { execSync } from 'child_process';
import { appendFileSync } from 'fs';

function run(cmd) {
    // Note: run-node.js is the restored CLI replacement for run-node.mjs
    return execSync(`node scripts/run-node.js ${cmd}`, { encoding: 'utf8', stdio: 'pipe' });
}

async function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

async function extractChapters() {
    for (let i = 0; i < 3; i++) {
        // 1. Capture a snapshot to identify elements
        const snapshotRaw = run(`browser snapshot`);
        const lines = snapshotRaw.split('\n');
        
        let paragraphs = [];
        let nextChapterRef = null;

        for (const line of lines) {
            // Find paragraphs (these usually appear as StaticText or generic nodes in AXTree)
            if (line.includes('paragraph') || line.includes('StaticText')) {
                const text = line.split('"')[1]; // Basic parser for the snapshot output
                if (text && text.length > 20) paragraphs.push(text.trim());
            }

            // Match Next Chapter navigation button by its ref
            if (line.toLowerCase().includes('next chapter') || line.toLowerCase().includes('next')) {
                const refMatch = line.match(/\[(e\d+)\]/);
                if (refMatch && !nextChapterRef) nextChapterRef = refMatch[1];
            }
        }

        // 2. Save extracted content
        const chapterText = paragraphs.join('\n\n');
        appendFileSync("paragraphs_out.txt", `\n\n--- Chapter Extracted ---\n\n${chapterText}\n\n`);

        // 3. Navigate to next page using the index ref
        if (nextChapterRef) {
            console.log(`Clicking next: ${nextChapterRef}`);
            run(`browser click ${nextChapterRef}`);
            await sleep(6000); // Wait for page navigation
        } else {
            console.log("No Next Chapter found.");
            break;
        }
    }
}

extractChapters();
```

## When To Use
Use this workflow whenever the goal is systematic data extraction from multi-page web content. The `browser snapshot` command builds a map of the page's accessibility tree, making it easy for both humans and models to pinpoint exact elements for interaction.
