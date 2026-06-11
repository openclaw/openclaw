import { escapeHtml } from "./text.js";
import type { BookBible, BookOutline, PublishPreview } from "./types.js";

export function buildPrintHtml(params: {
  bible: BookBible;
  outline: BookOutline;
  manuscript: string;
}): string {
  const body = params.manuscript
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => {
      if (block.startsWith("# ")) {
        return `<h1>${escapeHtml(block.slice(2))}</h1>`;
      }
      if (block.startsWith("## ")) {
        return `<h2>${escapeHtml(block.slice(3))}</h2>`;
      }
      return `<p>${escapeHtml(block)}</p>`;
    })
    .join("\n");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(params.bible.title)}</title>
  <style>
    @page { size: 6in 9in; margin: 0.75in; }
    body { font-family: Georgia, serif; line-height: 1.45; color: #111; }
    h1, h2 { page-break-after: avoid; }
    h1 { text-align: center; margin-top: 2in; }
  </style>
</head>
<body>${body}</body>
</html>`;
}

export function buildCoverSvg(bible: BookBible): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="2560" viewBox="0 0 1600 2560">
  <rect width="1600" height="2560" fill="#17202a"/>
  <rect x="120" y="120" width="1360" height="2320" fill="none" stroke="#f2c94c" stroke-width="12"/>
  <text x="800" y="820" text-anchor="middle" font-family="Georgia, serif" font-size="112" fill="#ffffff">${escapeHtml(bible.title)}</text>
  <text x="800" y="980" text-anchor="middle" font-family="Georgia, serif" font-size="52" fill="#f2c94c">${escapeHtml(bible.subtitle)}</text>
  <text x="800" y="2200" text-anchor="middle" font-family="Georgia, serif" font-size="64" fill="#ffffff">${escapeHtml(bible.penName)}</text>
</svg>`;
}

export function buildPublishPreview(bible: BookBible, manuscript: string): PublishPreview {
  const description = `${bible.readerPromise}\n\n${bible.premise}\n\nPrepared as an original AI-assisted manuscript review package.`;
  return {
    channel: "kdp",
    finalSubmitRequiresApproval: true,
    aiDisclosure:
      "Prepare KDP AI disclosure as AI-generated/AI-assisted content according to the operator's final production process.",
    kdpSelectDefault: true,
    title: bible.title,
    subtitle: bible.subtitle,
    description,
    keywords: [
      bible.genre,
      "clean suspense",
      "mystery novella",
      "courage",
      "family friendly",
      "fast read",
      "original fiction",
    ],
    categories: ["Fiction / Mystery & Detective / Traditional", "Fiction / Clean & Wholesome"],
    pricing: {
      ebookUsd: manuscript.length > 60_000 ? 4.99 : 2.99,
    },
    checklist: [
      "Confirm final title and subtitle are not misleading.",
      "Review AI disclosure before opening the KDP submission flow.",
      "Confirm KDP Select exclusivity before enrollment.",
      "Upload ebook.epub and cover asset only after all gates pass.",
      "Pause before final submit unless explicit approval is configured.",
    ],
  };
}
