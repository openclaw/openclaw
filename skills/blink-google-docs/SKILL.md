---
name: blink-google-docs
description: >
  Read and update Google Docs content. Get document text, append content,
  insert text. Use when asked to read or modify a Google Doc.
  Requires the document ID from the URL.
metadata:
  { "blink": { "requires_env": ["BLINK_API_KEY", "BLINK_AGENT_ID"], "connector": "google_docs" } }
---

# Blink Google Docs

Access Google Docs. Provider key: `google_docs`.
The DOCUMENT_ID is in the doc URL: `https://docs.google.com/document/d/DOCUMENT_ID/edit`

## Read document content
```bash
blink connector exec google_docs /documents/DOCUMENT_ID GET
```

## Get document metadata only
```bash
blink connector exec google_docs /documents/DOCUMENT_ID GET \
  '{"fields": "title,documentId,revisionId"}'
```

## Append text to a document
```bash
blink connector exec google_docs /documents/DOCUMENT_ID:batchUpdate POST '{
  "requests": [{
    "insertText": {
      "location": {"index": 1},
      "text": "New content to add\n"
    }
  }]
}'
```

## Replace text in a document
```bash
blink connector exec google_docs /documents/DOCUMENT_ID:batchUpdate POST '{
  "requests": [{
    "replaceAllText": {
      "containsText": {"text": "OLD TEXT", "matchCase": true},
      "replaceText": "NEW TEXT"
    }
  }]
}'
```

## Insert an inline image
```bash
blink connector exec google_docs /documents/DOCUMENT_ID:batchUpdate POST '{
  "requests": [{
    "insertInlineImage": {
      "uri": "https://example.com/image.png",
      "endOfSegmentLocation": {"segmentId": ""},
      "objectSize": {"width": {"magnitude": 400, "unit": "PT"}, "height": {"magnitude": 250, "unit": "PT"}}
    }
  }]
}'
```

## Valid batchUpdate request types
Only these requests exist in the Google Docs REST API v1:
`insertText`, `insertInlineImage`, `insertTable`, `insertTableRow`, `insertTableColumn`,
`insertPageBreak`, `insertSectionBreak`, `insertPerson`, `insertDate`,
`replaceAllText`, `replaceImage`, `replaceNamedRangeContent`,
`deleteContentRange`, `deleteTableRow`, `deleteTableColumn`, `deletePositionedObject`,
`deleteHeader`, `deleteFooter`, `deleteNamedRange`, `deleteParagraphBullets`, `deleteTab`,
`updateTextStyle`, `updateParagraphStyle`, `updateTableCellStyle`, `updateTableColumnProperties`,
`updateTableRowStyle`, `updateDocumentStyle`, `updateSectionStyle`, `updateDocumentTabProperties`,
`createParagraphBullets`, `createNamedRange`, `createHeader`, `createFooter`, `createFootnote`,
`mergeTableCells`, `unmergeTableCells`, `pinTableHeaderRows`, `addDocumentTab`

## IMPORTANT: No Sheets chart insertion
`insertSheetsChart` and `insertInlineSheetsChart` do NOT exist in the Google Docs REST API.
The response type `InsertInlineSheetsChartResponse` exists but the matching request was never shipped.
**Workaround:** Export the chart as an image (e.g. via quickchart.io or Google Sheets chart export),
then use `insertInlineImage` to embed it in the doc.

## Common use cases
- "Read my project proposal doc" → get document content
- "Add a summary section to my report" → batchUpdate insert text
- "What's in the meeting notes doc?" → get document, extract body text
- "Embed a chart from Sheets" → export chart as image URL, then insertInlineImage
