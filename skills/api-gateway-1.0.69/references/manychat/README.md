# ManyChat Routing Reference

**App name:** `manychat`
**Base URL proxied:** `api.manychat.com`

## API Path Pattern

```
/manychat/fb/{category}/{action}
```

## Common Endpoints

### Page Operations

#### Get Page Info

```bash
GET /manychat/fb/page/getInfo
```

#### List Tags

```bash
GET /manychat/fb/page/getTags
```

#### Create Tag

```bash
POST /manychat/fb/page/createTag
Content-Type: application/json

{
  "name": "New Tag"
}
```

#### Remove Tag

```bash
POST /manychat/fb/page/removeTag
Content-Type: application/json

{
  "tag_id": 123
}
```

#### List Custom Fields

```bash
GET /manychat/fb/page/getCustomFields
```

#### Create Custom Field

```bash
POST /manychat/fb/page/createCustomField
Content-Type: application/json

{
  "caption": "Phone Number",
  "type": "text",
  "description": "Customer phone number"
}
```

#### List Bot Fields

```bash
GET /manychat/fb/page/getBotFields
```

#### Set Bot Field

```bash
POST /manychat/fb/page/setBotField
Content-Type: application/json

{
  "field_id": 123,
  "field_value": 42
}
```

#### List Flows

```bash
GET /manychat/fb/page/getFlows
```

#### List Growth Tools

```bash
GET /manychat/fb/page/getGrowthTools
```

#### List OTN Topics

```bash
GET /manychat/fb/page/getOtnTopics
```

### Subscriber Operations

#### Get Subscriber Info

```bash
GET /manychat/fb/subscriber/getInfo?subscriber_id=123456789
```

#### Find Subscriber by Name

```bash
GET /manychat/fb/subscriber/findByName?name=John%20Doe
```

#### Find Subscriber by Email/Phone

```bash
GET /manychat/fb/subscriber/findBySystemField?email=john@example.com
```

#### Create Subscriber

```bash
POST /manychat/fb/subscriber/createSubscriber
Content-Type: application/json

{
  "first_name": "John",
  "last_name": "Doe",
  "phone": "+1234567890",
  "email": "john@example.com"
}
```

#### Update Subscriber

```bash
POST /manychat/fb/subscriber/updateSubscriber
Content-Type: application/json

{
  "subscriber_id": 123456789,
  "first_name": "John",
  "last_name": "Smith"
}
```

#### Add Tag to Subscriber

```bash
POST /manychat/fb/subscriber/addTag
Content-Type: application/json

{
  "subscriber_id": 123456789,
  "tag_id": 1
}
```

#### Set Custom Field

```bash
POST /manychat/fb/subscriber/setCustomField
Content-Type: application/json

{
  "subscriber_id": 123456789,
  "field_id": 1,
  "field_value": "value"
}
```

### Sending Operations

#### Send Content

```bash
POST /manychat/fb/sending/sendContent
Content-Type: application/json

{
  "subscriber_id": 123456789,
  "data": {
    "version": "v2",
    "content": {
      "messages": [
        {"type": "text", "text": "Hello!"}
      ]
    }
  }
}
```

#### Send Flow

```bash
POST /manychat/fb/sending/sendFlow
Content-Type: application/json

{
  "subscriber_id": 123456789,
  "flow_ns": "content123456"
}
```

## Rate Limits

| Endpoint Category     | Rate Limit           |
| --------------------- | -------------------- |
| Page GET endpoints    | 100 queries/second   |
| Page POST endpoints   | 10 queries/second    |
| Subscriber operations | 10-50 queries/second |
| Sending content       | 25 queries/second    |
| Sending flows         | 20 queries/second    |

## Notes

- Subscriber IDs are integers unique within a page
- Flow namespaces (flow_ns) identify automation flows
- Message tags are required for sending outside the 24-hour window
- All responses include `{"status": "success"}` or `{"status": "error"}`
- Custom field types: `text`, `number`, `date`, `datetime`, `boolean`

## Resources

- [ManyChat API Documentation](https://api.manychat.com/swagger)
- [ManyChat API Key Generation](https://help.manychat.com/hc/en-us/articles/14959510331420)
- [ManyChat Dev Program](https://help.manychat.com/hc/en-us/articles/14281269835548)
