# Google Docs Routing Reference

**App name:** `google-docs`
**Base URL proxied:** `docs.googleapis.com`

## API Path Pattern

```
/google-docs/v1/documents/{documentId}
```

## Common Endpoints

### Get Document

```bash
GET /google-docs/v1/documents/{documentId}
```

### Create Document

```bash
POST /google-docs/v1/documents
Content-Type: application/json

{
  "title": "New Document"
}
```

### Batch Update Document

```bash
POST /google-docs/v1/documents/{documentId}:batchUpdate
Content-Type: application/json

{
  "requests": [
    {
      "insertText": {
        "location": {"index": 1},
        "text": "Hello, World!"
      }
    }
  ]
}
```

## Common Requests for batchUpdate

### Insert Text

```json
{
  "insertText": {
    "location": { "index": 1 },
    "text": "Text to insert"
  }
}
```

### Delete Content

```json
{
  "deleteContentRange": {
    "range": {
      "startIndex": 1,
      "endIndex": 10
    }
  }
}
```

### Replace All Text

```json
{
  "replaceAllText": {
    "containsText": {
      "text": "{{placeholder}}",
      "matchCase": true
    },
    "replaceText": "replacement value"
  }
}
```

### Insert Table

```json
{
  "insertTable": {
    "location": { "index": 1 },
    "rows": 3,
    "columns": 3
  }
}
```

### Insert Inline Image

```json
{
  "insertInlineImage": {
    "location": { "index": 1 },
    "uri": "https://example.com/image.png",
    "objectSize": {
      "height": { "magnitude": 100, "unit": "PT" },
      "width": { "magnitude": 100, "unit": "PT" }
    }
  }
}
```

### Update Text Style

```json
{
  "updateTextStyle": {
    "range": {
      "startIndex": 1,
      "endIndex": 10
    },
    "textStyle": {
      "bold": true,
      "fontSize": { "magnitude": 14, "unit": "PT" }
    },
    "fields": "bold,fontSize"
  }
}
```

### Insert Page Break

```json
{
  "insertPageBreak": {
    "location": { "index": 1 }
  }
}
```

## Document Structure

The document body contains:

- `content` - Array of structural elements
- `body.content[].paragraph` - Paragraph element
- `body.content[].table` - Table element
- `body.content[].sectionBreak` - Section break

## Notes

- Authentication is automatic - the router injects the OAuth token
- Index positions are 1-based (document starts at index 1)
- Use `endOfSegmentLocation` to append at end
- Multiple requests in batchUpdate are applied atomically
- Get document first to find correct indices for updates
- The `fields` parameter in style updates uses field mask syntax

## Resources

- [API Overview](https://developers.google.com/docs/api/how-tos/overview)
- [Get Document](https://developers.google.com/docs/api/reference/rest/v1/documents/get)
- [Create Document](https://developers.google.com/docs/api/reference/rest/v1/documents/create)
- [Batch Update](https://developers.google.com/docs/api/reference/rest/v1/documents/batchUpdate)
- [Request Types Reference](https://developers.google.com/docs/api/reference/rest/v1/documents/request)
- [Document Structure Guide](https://developers.google.com/docs/api/concepts/structure)
