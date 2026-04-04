# Cognito Forms Routing Reference

**App name:** `cognito-forms`
**Base URL proxied:** `www.cognitoforms.com`

## API Path Pattern

```
/cognito-forms/api/{endpoint}
```

## Common Endpoints

### Forms

#### List Forms

```bash
GET /cognito-forms/api/forms
```

#### Get Form

```bash
GET /cognito-forms/api/forms/{formId}
```

### Entries

#### List Entries

```bash
GET /cognito-forms/api/forms/{formId}/entries
```

#### Get Entry

```bash
GET /cognito-forms/api/forms/{formId}/entries/{entryId}
```

#### Create Entry

```bash
POST /cognito-forms/api/forms/{formId}/entries
Content-Type: application/json

{
  "Name": {
    "First": "John",
    "Last": "Doe"
  },
  "Email": "john.doe@example.com"
}
```

#### Update Entry

```bash
PUT /cognito-forms/api/forms/{formId}/entries/{entryId}
Content-Type: application/json

{
  "Name": {
    "First": "Jane",
    "Last": "Doe"
  },
  "Email": "jane.doe@example.com"
}
```

#### Delete Entry

```bash
DELETE /cognito-forms/api/forms/{formId}/entries/{entryId}
```

### Documents

#### Get Document

```bash
GET /cognito-forms/api/forms/{formId}/entries/{entryId}/documents/{templateNumber}
```

### Files

#### Get File

```bash
GET /cognito-forms/api/files/{fileId}
```

### Form Availability

#### Set Form Availability

```bash
PUT /cognito-forms/api/forms/{formId}/availability
Content-Type: application/json

{
  "start": "2026-03-01T00:00:00Z",
  "end": "2026-03-31T23:59:59Z",
  "message": "This form is currently unavailable."
}
```

## Field Types

Complex fields use nested JSON objects:

- **Name**: `{"First": "...", "Last": "..."}`
- **Address**: `{"Line1": "...", "Line2": "...", "City": "...", "State": "...", "PostalCode": "..."}`
- **Choice (single)**: `"OptionValue"`
- **Choice (multiple)**: `["Option1", "Option2"]`

## Notes

- Form IDs can be internal form name (string) or numeric ID
- Entry IDs can be entry number (integer) or entry ID (GUID)
- Authentication is automatic - the router injects OAuth token
- Rate limit: 100 requests per 60 seconds
- File and document endpoints return temporary download URLs
- API scopes: Read, Read/Write, or Read/Write/Delete

## Resources

- [Cognito Forms API Overview](https://www.cognitoforms.com/support/475/data-integration/cognito-forms-api)
- [REST API Reference](https://www.cognitoforms.com/support/476/data-integration/cognito-forms-api/rest-api-reference)
- [API Reference](https://www.cognitoforms.com/support/476/data-integration/cognito-forms-api/api-reference)
