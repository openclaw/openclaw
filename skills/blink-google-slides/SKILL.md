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
blink connector exec google_slides /files GET \
  '{"q": "mimeType=\"application/vnd.google-apps.presentation\"", "fields": "files(id,name,createdTime,modifiedTime)", "pageSize": 20}'
```

## Get a presentation
```bash
blink connector exec google_slides /presentations/PRESENTATION_ID GET
```

## Create a presentation
```bash
blink connector exec google_slides /presentations POST '{
  "title": "My New Presentation"
}'
```

## Add a slide
```bash
blink connector exec google_slides /presentations/PRESENTATION_ID:batchUpdate POST '{
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
blink connector exec google_slides /presentations/PRESENTATION_ID:batchUpdate POST '{
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
blink connector exec google_slides /presentations/PRESENTATION_ID/pages/SLIDE_ID/thumbnail GET
```

## Export as PDF
```bash
blink connector exec google_slides /files/PRESENTATION_ID/export GET \
  '{"mimeType": "application/pdf"}'
```

## Embed a Google Sheets chart in a slide
Unlike Google Docs, the Slides API DOES support `createSheetsChart`:
```bash
blink connector exec google_slides /presentations/PRESENTATION_ID:batchUpdate POST '{
  "requests": [{
    "createSheetsChart": {
      "spreadsheetId": "SPREADSHEET_ID",
      "chartId": CHART_NUMERIC_ID,
      "linkingMode": "LINKED",
      "elementProperties": {
        "pageObjectId": "SLIDE_OBJECT_ID",
        "size": {"width": {"magnitude": 5000000, "unit": "EMU"}, "height": {"magnitude": 3000000, "unit": "EMU"}},
        "transform": {"scaleX": 1, "scaleY": 1, "translateX": 500000, "translateY": 500000, "unit": "EMU"}
      }
    }
  }]
}'
```
Get the chart's numeric ID from Sheets: `blink connector exec google_sheets /spreadsheets/SPREADSHEET_ID GET '{"fields":"sheets.charts"}'`

## Refresh an embedded Sheets chart
```bash
blink connector exec google_slides /presentations/PRESENTATION_ID:batchUpdate POST '{
  "requests": [{"refreshSheetsChart": {"objectId": "CHART_OBJECT_ID"}}]
}'
```

## NOTE: Google Docs does NOT support createSheetsChart
Only Google Slides has `createSheetsChart`. The Google Docs REST API has no equivalent —
use `insertInlineImage` with a chart image URL as a workaround in Docs.

## Common use cases
- "Create a slide deck for the Q1 review" → create presentation + add slides
- "What presentations do I have?" → list files via Drive API
- "Show me slide 3 of my roadmap deck" → get presentation, read slide content
- "Add a new slide with our key metrics" → batchUpdate with insertSlide + insertText
- "Export my pitch deck as PDF" → export via Drive API
- "Embed my Sheets chart in a slide" → createSheetsChart via batchUpdate
