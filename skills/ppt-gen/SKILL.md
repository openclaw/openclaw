---
name: ppt-gen
description: Generate PowerPoint (.pptx) presentations from a text outline or JSON structure.
metadata: { "openclaw": { "emoji": "📊", "requires": { "bins": ["node"] } } }
---

# PPT Generation

Generate professional PowerPoint presentations using `pptxgenjs`.

## When to use

- "Create a PPT about [topic]"
- "Generate slides for [content]"
- "Make a presentation with these points..."

## Usage

You (the agent) should first generate a JSON structure representing the slides, then pass it to the generator script.

### 1. Generate JSON Content

Structure the content like this:

```json
[
  {
    "title": "Slide Title",
    "text": "Main content text...",
    "bullets": ["Point 1", "Point 2"]
  },
  {
    "title": "Another Slide",
    "text": "More info",
    "image": "https://example.com/image.png"
  }
]
```

### 2. Run Generation Command

Save the JSON to a temp file (e.g. `slides.json`), then run:

```bash
# Using the built-in script
node skills/ppt-gen/generate.ts "output_filename.pptx" "slides.json"
```

The tool will generate the file and output the path. You should then tell the user where it is or offer to upload it.
