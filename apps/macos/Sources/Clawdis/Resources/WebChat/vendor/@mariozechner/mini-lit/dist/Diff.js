import * as DiffLib from "diff";
import { fc, html } from "./mini.js";
export const Diff = fc(({ oldText, newText, title, className = "" }) => {
    const parts = DiffLib.diffLines(oldText ?? "", newText ?? "");
    const lines = [];
    let addedCount = 0;
    let removedCount = 0;
    for (const part of parts) {
        // Split into lines and drop a trailing empty line (diffLines often ends with one)
        const raw = part.value.split("\n");
        if (raw[raw.length - 1] === "")
            raw.pop();
        for (const line of raw) {
            const prefix = part.added ? "+" : part.removed ? "-" : " ";
            // Keep text readable across light/dark by using theme foreground,
            // only tint the background to indicate add/remove.
            const rowClass = part.added ? "bg-emerald-500/15" : part.removed ? "bg-red-500/15" : "";
            if (part.added)
                addedCount++;
            if (part.removed)
                removedCount++;
            lines.push(html `<div class="${rowClass}">
               <pre class="m-0 px-4 py-0.5 text-xs font-mono text-foreground">${prefix} ${line}</pre>
            </div>`);
        }
    }
    const content = html ` <div class="overflow-auto max-h-96">${lines}</div> `;
    // If title is provided, render with a header like CodeBlock
    if (title) {
        return html `
         <div class="border border-border rounded-lg overflow-hidden ${className}">
            <div class="flex items-center justify-between px-3 py-1.5 bg-muted border-b border-border">
               <span class="text-xs text-muted-foreground font-mono">${title}</span>
               <span class="text-xs text-muted-foreground">
                  <span class="text-emerald-600">+${addedCount}</span>
                  <span class="mx-1">/</span>
                  <span class="text-red-600">-${removedCount}</span>
               </span>
            </div>
            ${content}
         </div>
      `;
    }
    // Otherwise, simple bordered container
    return html `<div class="border border-border rounded-lg overflow-hidden ${className}">${content}</div>`;
});
//# sourceMappingURL=Diff.js.map