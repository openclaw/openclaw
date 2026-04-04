# Google Forms Routing Reference

**App name:** `google-forms`
**Base URL proxied:** `forms.googleapis.com`

## API Path Pattern

```
/google-forms/v1/forms/{formId}
```

## Common Endpoints

### Get Form

```bash
GET /google-forms/v1/forms/{formId}
```

### Create Form

```bash
POST /google-forms/v1/forms
Content-Type: application/json

{
  "info": {
    "title": "Customer Feedback Survey"
  }
}
```

### Batch Update Form

```bash
POST /google-forms/v1/forms/{formId}:batchUpdate
Content-Type: application/json

{
  "requests": [
    {
      "createItem": {
        "item": {
          "title": "What is your name?",
          "questionItem": {
            "question": {
              "required": true,
              "textQuestion": {
                "paragraph": false
              }
            }
          }
        },
        "location": {"index": 0}
      }
    }
  ]
}
```

### List Responses

```bash
GET /google-forms/v1/forms/{formId}/responses
```

### Get Response

```bash
GET /google-forms/v1/forms/{formId}/responses/{responseId}
```

## Common Requests for batchUpdate

### Create Text Question

```json
{
  "createItem": {
    "item": {
      "title": "Question text",
      "questionItem": {
        "question": {
          "required": true,
          "textQuestion": { "paragraph": false }
        }
      }
    },
    "location": { "index": 0 }
  }
}
```

### Create Multiple Choice Question

```json
{
  "createItem": {
    "item": {
      "title": "Select an option",
      "questionItem": {
        "question": {
          "required": true,
          "choiceQuestion": {
            "type": "RADIO",
            "options": [{ "value": "Option A" }, { "value": "Option B" }, { "value": "Option C" }]
          }
        }
      }
    },
    "location": { "index": 0 }
  }
}
```

### Create Checkbox Question

```json
{
  "createItem": {
    "item": {
      "title": "Select all that apply",
      "questionItem": {
        "question": {
          "choiceQuestion": {
            "type": "CHECKBOX",
            "options": [{ "value": "Option 1" }, { "value": "Option 2" }]
          }
        }
      }
    },
    "location": { "index": 0 }
  }
}
```

### Create Scale Question

```json
{
  "createItem": {
    "item": {
      "title": "Rate your experience",
      "questionItem": {
        "question": {
          "scaleQuestion": {
            "low": 1,
            "high": 5,
            "lowLabel": "Poor",
            "highLabel": "Excellent"
          }
        }
      }
    },
    "location": { "index": 0 }
  }
}
```

### Update Form Info

```json
{
  "updateFormInfo": {
    "info": {
      "title": "New Form Title",
      "description": "Form description"
    },
    "updateMask": "title,description"
  }
}
```

### Delete Item

```json
{
  "deleteItem": {
    "location": { "index": 0 }
  }
}
```

## Question Types

- `textQuestion` - Short or paragraph text
- `choiceQuestion` - Radio, checkbox, or dropdown
- `scaleQuestion` - Linear scale
- `dateQuestion` - Date picker
- `timeQuestion` - Time picker
- `fileUploadQuestion` - File upload

## Notes

- Authentication is automatic - the router injects the OAuth token
- Form IDs can be found in the form URL
- Responses include `answers` keyed by question ID
- Use `updateMask` to specify which fields to update
- Location index is 0-based for item positioning

## Resources

- [API Overview](https://developers.google.com/workspace/forms/api/reference/rest)
- [Get Form](https://developers.google.com/workspace/forms/api/reference/rest/v1/forms/get)
- [Create Form](https://developers.google.com/workspace/forms/api/reference/rest/v1/forms/create)
- [Batch Update Form](https://developers.google.com/workspace/forms/api/reference/rest/v1/forms/batchUpdate)
- [Batch Update Request Types](https://developers.google.com/workspace/forms/api/reference/rest/v1/forms/batchUpdate#request)
- [List Responses](https://developers.google.com/workspace/forms/api/reference/rest/v1/forms.responses/list)
- [Get Response](https://developers.google.com/workspace/forms/api/reference/rest/v1/forms.responses/get)
- [Form Resource](https://developers.google.com/workspace/forms/api/reference/rest/v1/forms)
