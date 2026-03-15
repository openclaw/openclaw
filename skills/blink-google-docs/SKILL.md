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
bash scripts/call.sh google_docs /documents/DOCUMENT_ID GET
```

## Get document metadata only
```bash
bash scripts/call.sh google_docs /documents/DOCUMENT_ID GET \
  '{"fields": "title,documentId,revisionId"}'
```

## Append text to a document
```bash
bash scripts/call.sh google_docs /documents/DOCUMENT_ID:batchUpdate POST '{
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
bash scripts/call.sh google_docs /documents/DOCUMENT_ID:batchUpdate POST '{
  "requests": [{
    "replaceAllText": {
      "containsText": {"text": "OLD TEXT", "matchCase": true},
      "replaceText": "NEW TEXT"
    }
  }]
}'
```

## Common use cases
- "Read my project proposal doc" → get document content
- "Add a summary section to my report" → batchUpdate insert text
- "What's in the meeting notes doc?" → get document, extract body text
