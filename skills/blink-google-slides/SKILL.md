---
name: blink-google-slides
description: >
  Create, read, and edit Google Slides presentations. Use when asked to make
  slides, update presentations, add content, or export decks. Requires a
  linked Google connection.
metadata:
  { "blink": { "requires_env": ["BLINK_API_KEY", "BLINK_AGENT_ID"], "connector": "google_slides" } }
---

# Blink Google Slides

Access the user's Google Slides presentations. Provider key: `google_slides`.

## List presentations (via Drive)
```bash
bash scripts/call.sh google_drive /files GET \
  '{"q": "mimeType=\"application/vnd.google-apps.presentation\"", "fields": "files(id,name,createdTime,modifiedTime)", "pageSize": 20}'
```

## Get a presentation
```bash
bash scripts/call.sh google_slides /presentations/PRESENTATION_ID GET
```

## Create a presentation
```bash
bash scripts/call.sh google_slides /presentations POST '{
  "title": "My New Presentation"
}'
```

## Add a slide
```bash
bash scripts/call.sh google_slides /presentations/PRESENTATION_ID:batchUpdate POST '{
  "requests": [{
    "insertSlide": {
      "insertionIndex": 1,
      "slideLayoutReference": {"predefinedLayout": "TITLE_AND_BODY"}
    }
  }]
}'
```

## Add text to a slide element
```bash
bash scripts/call.sh google_slides /presentations/PRESENTATION_ID:batchUpdate POST '{
  "requests": [{
    "insertText": {
      "objectId": "ELEMENT_ID",
      "insertionIndex": 0,
      "text": "My slide content"
    }
  }]
}'
```

## Get page thumbnail
```bash
bash scripts/call.sh google_slides /presentations/PRESENTATION_ID/pages/SLIDE_ID/thumbnail GET
```

## Export as PDF
```bash
bash scripts/call.sh google_drive /files/PRESENTATION_ID/export GET \
  '{"mimeType": "application/pdf"}'
```

## Common use cases
- "Create a slide deck for the Q1 review" → create presentation + add slides
- "What presentations do I have?" → list files via Drive API
- "Show me slide 3 of my roadmap deck" → get presentation, read slide content
- "Add a new slide with our key metrics" → batchUpdate with insertSlide + insertText
- "Export my pitch deck as PDF" → export via Drive API
