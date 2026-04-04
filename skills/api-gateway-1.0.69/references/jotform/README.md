# JotForm Routing Reference

**App name:** `jotform`
**Base URL proxied:** `api.jotform.com`

## API Path Pattern

```
/jotform/{endpoint}
```

## Common Endpoints

### User

#### Get User Info

```bash
GET /jotform/user
```

#### Get User Forms

```bash
GET /jotform/user/forms?limit=20&offset=0
```

#### Get User Submissions

```bash
GET /jotform/user/submissions?limit=20&offset=0
```

#### Get User Usage

```bash
GET /jotform/user/usage
```

#### Get User History

```bash
GET /jotform/user/history?limit=20
```

### Forms

#### Get Form

```bash
GET /jotform/form/{formId}
```

#### Get Form Questions

```bash
GET /jotform/form/{formId}/questions
```

#### Get Form Properties

```bash
GET /jotform/form/{formId}/properties
```

#### Get Form Submissions

```bash
GET /jotform/form/{formId}/submissions?limit=20&offset=0
```

With filter:

```bash
GET /jotform/form/{formId}/submissions?filter={"created_at:gt":"2024-01-01"}
```

#### Get Form Files

```bash
GET /jotform/form/{formId}/files
```

#### Create Form

```bash
POST /jotform/user/forms
Content-Type: application/json

{
  "properties": {
    "title": "Contact Form"
  },
  "questions": {
    "1": {
      "type": "control_textbox",
      "text": "Name",
      "name": "name"
    },
    "2": {
      "type": "control_email",
      "text": "Email",
      "name": "email"
    }
  }
}
```

#### Delete Form

```bash
DELETE /jotform/form/{formId}
```

### Submissions

#### Get Submission

```bash
GET /jotform/submission/{submissionId}
```

#### Update Submission

```bash
POST /jotform/submission/{submissionId}
Content-Type: application/x-www-form-urlencoded

submission[3][first]=John&submission[3][last]=Doe
```

Note: Use question IDs from the form questions endpoint. The submission field format is `submission[questionId][subfield]=value`.

#### Delete Submission

```bash
DELETE /jotform/submission/{submissionId}
```

### Reports

#### Get Form Reports

```bash
GET /jotform/form/{formId}/reports
```

### Webhooks

#### Get Form Webhooks

```bash
GET /jotform/form/{formId}/webhooks
```

#### Create Webhook

```bash
POST /jotform/form/{formId}/webhooks
Content-Type: application/x-www-form-urlencoded

webhookURL=https://example.com/webhook
```

#### Delete Webhook

```bash
DELETE /jotform/form/{formId}/webhooks/{webhookIndex}
```

## Question Types

- `control_textbox` - Single line text
- `control_textarea` - Multi-line text
- `control_email` - Email
- `control_phone` - Phone number
- `control_dropdown` - Dropdown
- `control_radio` - Radio buttons
- `control_checkbox` - Checkboxes
- `control_datetime` - Date/time picker
- `control_fileupload` - File upload
- `control_signature` - Signature

## Filter Syntax

Filters use JSON format:

- `{"field:gt":"value"}` - Greater than
- `{"field:lt":"value"}` - Less than
- `{"field:eq":"value"}` - Equal to
- `{"field:ne":"value"}` - Not equal to

## Notes

- Authentication is automatic - the router injects the `APIKEY` header
- Form IDs are numeric
- Submissions include all answers as key-value pairs
- Use `orderby` parameter to sort results (e.g., `orderby=created_at`)
- Pagination uses `limit` and `offset` parameters

## Resources

- [API Overview](https://api.jotform.com/docs/)
- [Get User Info](https://api.jotform.com/docs/#user)
- [Get User Forms](https://api.jotform.com/docs/#user-forms)
- [Get User Submissions](https://api.jotform.com/docs/#user-submissions)
- [Get Form Details](https://api.jotform.com/docs/#form-id)
- [Get Form Questions](https://api.jotform.com/docs/#form-id-questions)
- [Get Form Submissions](https://api.jotform.com/docs/#form-id-submissions)
- [Get Submission](https://api.jotform.com/docs/#submission-id)
- [Webhooks](https://api.jotform.com/docs/#form-id-webhooks)
