---
name: openclaw-template-filler
description: >
  Use this skill when the user wants to fill a template document with content. The template can be
  a Word .docx, PowerPoint .pptx, or plain text file with placeholder sections. Content can come
  from text pasted in chat or a file path the user provides. Trigger on: "sablonu doldur",
  "template'i doldur", "template doldur", "bu template'e ekle", "fill this template",
  "fill in the blanks", "yerlestirir misin", "dosyami doldur", or whenever a user has a structured
  document with placeholder sections and content to slot in.
metadata:
  {
    "openclaw":
      {
        "emoji": "📝",
        "os": ["darwin", "linux"],
        "requires": { "bins": ["python3"] },
        "install":
          [
            {
              "id": "pip-deps",
              "kind": "shell",
              "command": "pip3 install python-docx python-pptx",
              "label": "Install python-docx and python-pptx",
            },
          ],
      },
  }
---

# openclaw-template-filler

Fill a template document by replacing placeholder sections with real content.

The fill script is at: `{baseDir}/scripts/fill_template.py`

## Step 1: Get file paths

Ask for:

1. Template file path (e.g. `~/Desktop/teklif.docx`)
2. Content — either pasted text in chat or a second file path

If unclear, list files:

```bash
ls ~/Desktop/*.docx ~/Desktop/*.pptx 2>/dev/null
```

## Step 2: List placeholders in the template

```bash
python3 {baseDir}/scripts/fill_template.py --list ~/Desktop/teklif.docx
```

## Step 3: Read content file (if user provided a file)

```bash
python3 {baseDir}/scripts/fill_template.py --read-content ~/Desktop/icerik.docx
```

If content is pasted in chat, skip this step.

## Step 4: Fill the template

Replace each placeholder with the matching content. Use this command:

```bash
python3 {baseDir}/scripts/fill_template.py --fill ~/Desktop/teklif.docx --output ~/Desktop/teklif_filled.docx --replacements '{"[Buraya X gelecek]": "gerçek içerik buraya"}'
```

Output file: same folder as input, `_filled` suffix before extension.

## Step 5: Confirm

Tell the user:

- Full path of the saved file
- What went into each section
- Anything left blank (shown as `[CONTENT NOT PROVIDED]`)

## Placeholder matching rules

- Turkish: `[Buraya X gelecek]`, `[Buraya X yazılacak]`, `[BURAYA X YAZINIZ]`
- English: `[Insert X here]`, `[Company Name]`, `(X section here)`
- Match by heading similarity and keyword overlap
- When unsure, ask the user to confirm the match
