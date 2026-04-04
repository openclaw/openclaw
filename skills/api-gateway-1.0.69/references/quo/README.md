# Quo Routing Reference

**App name:** `quo`
**Base URL proxied:** `api.openphone.com`

## API Path Pattern

```
/quo/v1/{resource}
```

## Common Endpoints

### Phone Numbers

#### List Phone Numbers

```bash
GET /quo/v1/phone-numbers
```

### Users

#### List Users

```bash
GET /quo/v1/users?maxResults=50
```

#### Get User

```bash
GET /quo/v1/users/{userId}
```

### Messages

#### Send Text Message

```bash
POST /quo/v1/messages
Content-Type: application/json

{
  "content": "Hello, world!",
  "from": "PN123abc",
  "to": ["+15555555555"]
}
```

#### List Messages

```bash
GET /quo/v1/messages?phoneNumberId=PN123abc&participants[]=+15555555555&maxResults=100
```

#### Get Message

```bash
GET /quo/v1/messages/{messageId}
```

### Calls

#### List Calls

```bash
GET /quo/v1/calls?phoneNumberId=PN123abc&participants[]=+15555555555&maxResults=100
```

#### Get Call

```bash
GET /quo/v1/calls/{callId}
```

#### Get Call Recordings

```bash
GET /quo/v1/call-recordings/{callId}
```

#### Get Call Summary

```bash
GET /quo/v1/call-summaries/{callId}
```

#### Get Call Transcript

```bash
GET /quo/v1/call-transcripts/{callId}
```

#### Get Call Voicemail

```bash
GET /quo/v1/call-voicemails/{callId}
```

### Contacts

#### List Contacts

```bash
GET /quo/v1/contacts?maxResults=50
```

#### Get Contact

```bash
GET /quo/v1/contacts/{contactId}
```

#### Create Contact

```bash
POST /quo/v1/contacts
Content-Type: application/json

{
  "defaultFields": {
    "firstName": "Jane",
    "lastName": "Doe",
    "phoneNumbers": [{"name": "mobile", "value": "+15555555555"}]
  }
}
```

#### Update Contact

```bash
PATCH /quo/v1/contacts/{contactId}
Content-Type: application/json

{
  "defaultFields": {
    "company": "New Company"
  }
}
```

#### Delete Contact

```bash
DELETE /quo/v1/contacts/{contactId}
```

#### Get Contact Custom Fields

```bash
GET /quo/v1/contact-custom-fields
```

### Conversations

#### List Conversations

```bash
GET /quo/v1/conversations?maxResults=100
```

### Webhooks

#### List Webhooks

```bash
GET /quo/v1/webhooks
```

#### Get Webhook

```bash
GET /quo/v1/webhooks/{webhookId}
```

#### Create Webhook

```bash
POST /quo/v1/webhooks
Content-Type: application/json

{
  "url": "https://your-webhook-url.com/calls",
  "resourceType": "call"
}
```

Resource types: `call`, `message`, `callSummary`, `callTranscript`

#### Delete Webhook

```bash
DELETE /quo/v1/webhooks/{webhookId}
```

## Notes

- Phone number IDs start with `PN`
- User IDs start with `US`
- Call/Message IDs start with `AC`
- Phone numbers must be in E.164 format (e.g., `+15555555555`)
- Uses token-based pagination with `pageToken` parameter
- Maximum 1600 characters per SMS message
- List calls requires exactly 1 participant (1:1 conversations only)

## Resources

- [Quo API Introduction](https://www.quo.com/docs/mdx/api-reference/introduction)
- [Quo API Authentication](https://www.quo.com/docs/mdx/api-reference/authentication)
- [Quo Support Center](https://support.quo.com/core-concepts/integrations/api)
