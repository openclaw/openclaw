# Google Slides Routing Reference

**App name:** `google-slides`
**Base URL proxied:** `slides.googleapis.com`

## API Path Pattern

```
/google-slides/v1/presentations/{presentationId}
```

## Common Endpoints

### Create Presentation

```bash
POST /google-slides/v1/presentations
Content-Type: application/json

{
  "title": "My Presentation"
}
```

### Get Presentation

```bash
GET /google-slides/v1/presentations/{presentationId}
```

### Get Page (Slide)

```bash
GET /google-slides/v1/presentations/{presentationId}/pages/{pageId}
```

### Get Page Thumbnail

```bash
GET /google-slides/v1/presentations/{presentationId}/pages/{pageId}/thumbnail
```

### Batch Update (All Modifications)

```bash
POST /google-slides/v1/presentations/{presentationId}:batchUpdate
Content-Type: application/json

{
  "requests": [...]
}
```

### Create Slide

```bash
POST /google-slides/v1/presentations/{presentationId}:batchUpdate
Content-Type: application/json

{
  "requests": [
    {
      "createSlide": {
        "objectId": "slide_001",
        "slideLayoutReference": {
          "predefinedLayout": "TITLE_AND_BODY"
        }
      }
    }
  ]
}
```

Predefined layouts: `BLANK`, `TITLE`, `TITLE_AND_BODY`, `TITLE_AND_TWO_COLUMNS`, `TITLE_ONLY`, `SECTION_HEADER`, `ONE_COLUMN_TEXT`, `MAIN_POINT`, `BIG_NUMBER`

### Insert Text

```bash
POST /google-slides/v1/presentations/{presentationId}:batchUpdate
Content-Type: application/json

{
  "requests": [
    {
      "insertText": {
        "objectId": "{shapeId}",
        "text": "Hello, World!",
        "insertionIndex": 0
      }
    }
  ]
}
```

### Create Shape (Text Box)

```bash
POST /google-slides/v1/presentations/{presentationId}:batchUpdate
Content-Type: application/json

{
  "requests": [
    {
      "createShape": {
        "objectId": "shape_001",
        "shapeType": "TEXT_BOX",
        "elementProperties": {
          "pageObjectId": "{slideId}",
          "size": {
            "width": {"magnitude": 300, "unit": "PT"},
            "height": {"magnitude": 100, "unit": "PT"}
          },
          "transform": {
            "scaleX": 1,
            "scaleY": 1,
            "translateX": 100,
            "translateY": 100,
            "unit": "PT"
          }
        }
      }
    }
  ]
}
```

### Create Image

```bash
POST /google-slides/v1/presentations/{presentationId}:batchUpdate
Content-Type: application/json

{
  "requests": [
    {
      "createImage": {
        "objectId": "image_001",
        "url": "https://example.com/image.png",
        "elementProperties": {
          "pageObjectId": "{slideId}",
          "size": {
            "width": {"magnitude": 200, "unit": "PT"},
            "height": {"magnitude": 200, "unit": "PT"}
          }
        }
      }
    }
  ]
}
```

### Delete Object

```bash
POST /google-slides/v1/presentations/{presentationId}:batchUpdate
Content-Type: application/json

{
  "requests": [
    {
      "deleteObject": {
        "objectId": "{objectId}"
      }
    }
  ]
}
```

### Replace All Text (Template Substitution)

```bash
POST /google-slides/v1/presentations/{presentationId}:batchUpdate
Content-Type: application/json

{
  "requests": [
    {
      "replaceAllText": {
        "containsText": {
          "text": "{{placeholder}}",
          "matchCase": true
        },
        "replaceText": "Actual Value"
      }
    }
  ]
}
```

### Update Text Style

```bash
POST /google-slides/v1/presentations/{presentationId}:batchUpdate
Content-Type: application/json

{
  "requests": [
    {
      "updateTextStyle": {
        "objectId": "{shapeId}",
        "textRange": {"type": "ALL"},
        "style": {
          "bold": true,
          "fontSize": {"magnitude": 24, "unit": "PT"}
        },
        "fields": "bold,fontSize"
      }
    }
  ]
}
```

## Notes

- Object IDs must be unique within a presentation
- Use batchUpdate for all modifications (adding slides, text, shapes, etc.)
- Multiple requests in a batchUpdate are applied atomically
- Sizes and positions use PT (points) as the unit (72 points = 1 inch)
- Use `replaceAllText` for template-based presentation generation

## Resources

- [Slides API Overview](https://developers.google.com/slides/api/reference/rest)
- [Presentations](https://developers.google.com/slides/api/reference/rest/v1/presentations)
- [Pages](https://developers.google.com/slides/api/reference/rest/v1/presentations.pages)
- [BatchUpdate Requests](https://developers.google.com/slides/api/reference/rest/v1/presentations/batchUpdate)
- [Page Layouts](https://developers.google.com/slides/api/reference/rest/v1/presentations/create#predefinedlayout)
