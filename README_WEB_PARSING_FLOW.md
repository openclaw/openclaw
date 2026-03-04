# OpenClaw Web Parsing Flow

This document details the automated flow for extracting text content from web pages and navigating through them using the OpenClaw browser CLI.

## Overview
The goal is to navigate to a page, extract the text content (paragraphs), optionally save the page as a PDF for debug or reference, and click navigation links to proceed to the next page automatically. 

## Approach

We use a Node script (`downloader.mjs`) that invokes the `openclaw browser` CLI via `child_process.execSync` to orchestrate actions in a Chrome tab. 

### Key Commands Used

- `node scripts/run-node.mjs browser pdf`: Saves the current page as a PDF (useful as a checkpoint or verification).
- `node scripts/run-node.mjs browser snapshot`: Captures a snapshot of the page accessibility/DOM tree. We parse this output instead of evaluating JavaScript on the page directly, as `evaluate` can be prone to escaping and execution issues depending on the environment.
- `node scripts/run-node.mjs browser click <ref>`: Clicks an element based on its exact `ref` id returned from the snapshot command.

### Flow Execution Steps

1. **Trigger PDF (Optional)**
   Save a PDF snapshot by running `openclaw browser pdf`.
2. **Take DOM Snapshot**
   Run `openclaw browser snapshot` to get the accessibility tree representation of the DOM.
3. **Parse Snapshot Output**
   Read the returned text. 
   - Parse all standard paragraphs (e.g. lines matching `- paragraph [ref=...]: <content>`).
   - Find navigation elements by scanning for links, saving their `ref` ID (e.g. a link labeled "Next Chapter").
4. **Append Extracted Content**
   Join the text from the parsed paragraphs and append it to an output file (`paragraphs_by_snapshot.txt`).
5. **Navigate**
   - Check if a `ref` for the "Next" navigation button was found.
   - Run `openclaw browser click <ref>`. 
   - Add a delay (e.g., `sleep(5000)`) to allow the new page to load.
6. **Repeat**
   Loop through steps 1-5 for as many pages/chapters as needed.

## Example Script (`downloader.mjs`)

```javascript
import { execSync } from 'child_process';
import { appendFileSync } from 'fs';

function run(cmd) {
    return execSync(cmd, { encoding: 'utf8', stdio: 'pipe' });
}

async function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

async function main() {
    for (let i = 0; i < 3; i++) {
        run(`node scripts/run-node.mjs browser pdf`);
        const snapshotRaw = run(`node scripts/run-node.mjs browser snapshot`);
        
        const lines = snapshotRaw.split('\n');
        const paragraphs = [];
        let nextChapterRef = null;

        for (const line of lines) {
            // Match paragraphs
            const pMatch = line.match(/^\s*-\s*paragraph\s*(?:\[ref=([^\]]+)\])?:\s*(.*)$/);
            if (pMatch) paragraphs.push(pMatch[2].trim());

            // Match "Next Chapter" link
            const nextMatch = line.match(/^.*link\s+"[^"]*Next Chapter[^"]*"\s*\[ref=([^\]]+)\].*/i);
            if (nextMatch && !nextChapterRef) nextChapterRef = nextMatch[1];
        }

        appendFileSync("output.txt", `\\n\\n${paragraphs.join('\\n\\n')}\\n\\n`);

        if (nextChapterRef) {
            run(`node scripts/run-node.mjs browser click ${nextChapterRef}`);
            await sleep(5000);
        } else {
            break;
        }
    }
}

main();
```
