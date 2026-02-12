---
name: docx-gen
description: Generate Word (.docx) documents from structured content.
metadata: { "openclaw": { "emoji": "📝", "requires": { "bins": ["node"] } } }
---

# Docx Generation

Generate structured Word documents using `docx`.

## When to use

- "Write a brief/report about [topic]"
- "Generate a docx file"
- "Create a formal document"

## Usage

### 1. Generate JSON Content

Structure the content like this:

```json
{
  "title": "Document Title",
  "sections": [
    {
      "heading": "Section 1",
      "text": "Paragraph text..."
    },
    {
      "heading": "Key Points",
      "bullets": ["Point 1", "Point 2"]
    }
  ]
}
```

### 2. Run Generation Command

Save the JSON to a temp file (e.g. `doc.json`), then run:

```bash
# Using the built-in script
node skills/docx-gen/generate.ts "output_filename.docx" "doc.json"
```
