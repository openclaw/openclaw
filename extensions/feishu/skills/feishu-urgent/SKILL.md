---
name: feishu-urgent
description: |
  Feishu urgent/buzz push notifications. Activate when user asks to urgently notify, buzz, or escalate a message to specific people.
---

# Feishu Urgent Tool

Single tool `feishu_urgent` for sending urgent (buzz) push notifications for an already-sent message.

## Usage

The message must already exist (already sent). Obtain `message_id` first (e.g. from a prior send result), then buzz the recipients.

```json
{
  "message_id": "om_xxx",
  "user_ids": ["ou_xxx", "ou_yyy"]
}
```

Default `urgent_type` is `app` (in-app buzz). Specify `sms` or `phone` for stronger delivery:

```json
{
  "message_id": "om_xxx",
  "user_ids": ["ou_xxx"],
  "urgent_type": "sms"
}
```

## Urgent Types

| Type    | Delivery method          | Cost           |
| ------- | ------------------------ | -------------- |
| `app`   | In-app buzz notification | Free           |
| `sms`   | SMS to recipient's phone | May incur cost |
| `phone` | Voice call to recipient  | May incur cost |

## Response

```json
{
  "ok": true,
  "message_id": "om_xxx",
  "urgent_type": "app",
  "invalid_user_list": []
}
```

`invalid_user_list`: user IDs that could not be buzzed (not members of the chat, or invalid).

## Common Errors

- **Code 230024**: Quota exceeded ("Reach the upper limit of urgent message"). Check tenant quota in Feishu admin console → Cost Center.
- **HTTP 400**: One or more `user_ids` are invalid or not members of the chat.

## Configuration

```yaml
channels:
  feishu:
    tools:
      urgent: true # default: false (opt-in)
```

**Note:** Disabled by default to prevent accidental quota consumption. Enable explicitly when urgent notification capability is needed.

## Permissions

Required scopes (add to app in Feishu Open Platform):

| urgent_type | Required scope            |
| ----------- | ------------------------- |
| `app`       | `im:message.urgent_app`   |
| `sms`       | `im:message.urgent_sms`   |
| `phone`     | `im:message.urgent_phone` |
