# Phase 2, Task 05: Document Parsers

**Phase:** 2 - Manual Ingestion + Web Crawler
**Task:** Implement document parsers for PDF, DOCX, HTML, Markdown
**Duration:** 1 day
**Complexity:** Low
**Depends on:** Task 01 (Ingestion Pipeline)

---

## Task Overview

Implement parsers for various document formats:
- PDF: pdfjs-dist
- DOCX: mammoth
- HTML: @mozilla/readability
- Markdown: native

## File Structure

```
src/knowledge/ingest/parsers/
├── pdf.ts                 # PDF parser
├── docx.ts                # DOCX parser
├── html.ts                # HTML parser
└── markdown.ts            # Markdown parser
```

## PDF Parser

```typescript
import * as pdfjs from 'pdfjs-dist';

export async function parsePDF(content: string | Buffer): Promise<{ text: string }> {
  const data = typeof content === 'string' ? Buffer.from(content, 'utf-8') : content;

  const loadingTask = pdfjs.getDocument({ data: Array.from(data) });
  const pdf = await loadingTask.promise;

  let fullText = '';

  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const textContent = await page.getTextContent();
    const pageText = textContent.items.map((item: any) => item.str).join(' ');
    fullText += pageText + '\n';
  }

  return { text: fullText.trim() };
}
```

## DOCX Parser

```typescript
import mammoth from 'mammoth';

export async function parseDOCX(content: string | Buffer): Promise<{ text: string }> {
  const buffer = typeof content === 'string' ? Buffer.from(content, 'utf-8') : content;

  const result = await mammoth.extractRawText({ buffer });

  return { text: result.value };
}
```

## HTML Parser

```typescript
import { Readability } from '@mozilla/readability';
import { DOMParser } from 'linkedom';

export async function parseHTML(content: string): Promise<{ text: string; metadata?: any }> {
  const doc = new DOMParser().parseFromString(content, 'text/html');
  const reader = new Readability(doc as any);
  const article = reader.parse();

  if (!article) {
    return { text: '' };
  }

  return {
    text: article.textContent,
    metadata: {
      title: article.title,
      excerpt: article.excerpt,
      length: article.length,
    },
  };
}
```

## Markdown Parser

```typescript
import MarkdownIt from 'markdown-it';

const md = new MarkdownIt();

export async function parseMarkdown(content: string): Promise<{ text: string }> {
  // Render markdown to HTML, then extract text
  const html = md.render(content);

  // Strip HTML tags
  const text = html.replace(/<[^>]*>/g, '');

  return { text: text.trim() };
}
```

## Dependencies

```bash
pnpm add mammoth markdown-it
# pdfjs-dist already exists
# @mozilla/readability already exists
# linkedom already exists
```

## Success Criteria

- [ ] PDF parser extracts text correctly
- [ ] DOCX parser converts to markdown
- [ ] HTML parser extracts main content (Readability)
- [ ] Markdown parser renders and extracts text
- [ ] All parsers handle errors gracefully
- [ ] Tests pass

## References

- Parser Libraries: `docs/plans/graphrag/ZAI-EVALUATION.md` Part 3
