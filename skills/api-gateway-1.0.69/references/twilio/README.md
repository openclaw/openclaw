# Twilio Routing Reference

**App name:** `twilio`
**Base URL proxied:** `api.twilio.com`

## API Path Pattern

```
/twilio/2010-04-01/Accounts/{AccountSid}/{resource}.json
```

**Important:** Most Twilio endpoints require your Account SID in the path. Get it from `/Accounts.json`.

## Common Endpoints

### Accounts

#### List Accounts

```bash
GET /twilio/2010-04-01/Accounts.json
```

#### Get Account

```bash
GET /twilio/2010-04-01/Accounts/{AccountSid}.json
```

### Messages (SMS/MMS)

#### List Messages

```bash
GET /twilio/2010-04-01/Accounts/{AccountSid}/Messages.json
```

#### Send Message

```bash
POST /twilio/2010-04-01/Accounts/{AccountSid}/Messages.json
Content-Type: application/x-www-form-urlencoded

To=+15559876543&From=+15551234567&Body=Hello%20from%20Twilio!
```

#### Get Message

```bash
GET /twilio/2010-04-01/Accounts/{AccountSid}/Messages/{MessageSid}.json
```

#### Delete Message

```bash
DELETE /twilio/2010-04-01/Accounts/{AccountSid}/Messages/{MessageSid}.json
```

### Calls (Voice)

#### List Calls

```bash
GET /twilio/2010-04-01/Accounts/{AccountSid}/Calls.json
```

#### Make Call

```bash
POST /twilio/2010-04-01/Accounts/{AccountSid}/Calls.json
Content-Type: application/x-www-form-urlencoded

To=+15559876543&From=+15551234567&Url=https://example.com/twiml
```

#### Get Call

```bash
GET /twilio/2010-04-01/Accounts/{AccountSid}/Calls/{CallSid}.json
```

#### End Call

```bash
POST /twilio/2010-04-01/Accounts/{AccountSid}/Calls/{CallSid}.json
Content-Type: application/x-www-form-urlencoded

Status=completed
```

### Phone Numbers

#### List Incoming Phone Numbers

```bash
GET /twilio/2010-04-01/Accounts/{AccountSid}/IncomingPhoneNumbers.json
```

#### Get Phone Number

```bash
GET /twilio/2010-04-01/Accounts/{AccountSid}/IncomingPhoneNumbers/{PhoneNumberSid}.json
```

#### Update Phone Number

```bash
POST /twilio/2010-04-01/Accounts/{AccountSid}/IncomingPhoneNumbers/{PhoneNumberSid}.json
Content-Type: application/x-www-form-urlencoded

FriendlyName=Updated%20Name
```

### Applications

#### List Applications

```bash
GET /twilio/2010-04-01/Accounts/{AccountSid}/Applications.json
```

#### Create Application

```bash
POST /twilio/2010-04-01/Accounts/{AccountSid}/Applications.json
Content-Type: application/x-www-form-urlencoded

FriendlyName=My%20App&VoiceUrl=https://example.com/voice
```

#### Delete Application

```bash
DELETE /twilio/2010-04-01/Accounts/{AccountSid}/Applications/{ApplicationSid}.json
```

### Queues

#### List Queues

```bash
GET /twilio/2010-04-01/Accounts/{AccountSid}/Queues.json
```

#### Create Queue

```bash
POST /twilio/2010-04-01/Accounts/{AccountSid}/Queues.json
Content-Type: application/x-www-form-urlencoded

FriendlyName=Support%20Queue&MaxSize=100
```

### Usage Records

#### List Usage Records

```bash
GET /twilio/2010-04-01/Accounts/{AccountSid}/Usage/Records.json
```

## Pagination

Uses page-based pagination:

```bash
GET /twilio/2010-04-01/Accounts/{AccountSid}/Messages.json?PageSize=50&Page=0
```

**Parameters:**

- `PageSize` - Results per page (default: 50)
- `Page` - Page number (0-indexed)

Response includes `next_page_uri` for fetching next page.

## Notes

- All endpoints require `/2010-04-01/` API version prefix
- Request bodies use `application/x-www-form-urlencoded` (not JSON)
- Phone numbers must be in E.164 format (+15551234567)
- SID prefixes: AC (account), SM/MM (messages), CA (calls), PN (phone numbers), AP (applications), QU (queues)
- POST is used for both creating and updating resources
- DELETE returns 204 No Content on success

## Resources

- [Twilio API Overview](https://www.twilio.com/docs/usage/api)
- [Messages API](https://www.twilio.com/docs/messaging/api/message-resource)
- [Calls API](https://www.twilio.com/docs/voice/api/call-resource)
