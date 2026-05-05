# Mail Action Client

Shared helper for operational mail actions in Stitch.

Run the helper directly:

```bash
/app/mail-action-client/cli.js --json '{"action":"draft","mailbox":"chris","subject":"TEST IGNORE","body":"Hello","to":["person@example.com"]}'
```

Or through Node if needed:

```bash
node /app/mail-action-client/cli.js --json '{"action":"draft","mailbox":"chris","subject":"TEST IGNORE","body":"Hello","to":["person@example.com"]}'
```

Supported v1 actions:

- `draft`
- `reply`
- `fetch_thread`
- `fetch_thread_by_subject`
- `lookup_history`
- `download_attachments` (Microsoft mailboxes only)

Attachment download flow:

```json
{
  "action": "download_attachments",
  "mailbox": "chris",
  "messageId": "MESSAGE_ID"
}
```

The Microsoft reader saves allowed quote-review attachment types (`pdf`, `png`,
`jpg`, `jpeg`) under the mailbox workspace attachment folder and returns
metadata including `name`, `contentType`, `size`, `sha256`, and `path`. The
helper does not expose provider tokens or arbitrary filesystem paths.

Quote attachment review flow:

After downloading attachments, pass the returned host paths to:

```bash
/Users/chrisreyes/openclaw/quote-attachment-review/cli.js --json '{
  "paths": ["/Users/chrisreyes/.openclaw/workspace/mail-chris/attachments/.../Schedule.pdf"],
  "renderPages": 1
}'
```

The review helper only reads files inside OpenClaw mail attachment folders. It
returns PDF text/metadata, image metadata, SHA-256 values, and optional rendered
PDF page PNG paths for visual review.

Operational draft flow:

1. Resolve recipients first if the target is implied by a project, item, client, or team name.
2. Pass the full recipient provenance object as `recipientResolution`.
3. Use the helper result as the source of truth.

Example operational draft:

```json
{
  "action": "draft",
  "mailbox": "chris",
  "subject": "TEST IGNORE - Missing info needed",
  "body": "Hi Cindy,\n\nWe still need the missing information to keep this moving.\n\nThank you,",
  "to": ["cindy@clementsdesign.com"],
  "recipientResolution": {
    "found_in": "project_contacts",
    "provider": "prestigio_app",
    "recipients": [
      {
        "name": "Cindy Ou",
        "email": "cindy@clementsdesign.com"
      }
    ]
  }
}
```

Normalized result fields:

- `ok`
- `requestId`
- `action`
- `provider`
- `mailbox`
- `summary`
- `plain_language_summary`
- `result`
- `recipientResolution`
- `recipientResolutionSummary`
- `found_in`
- `aliases_tried`
- `confidence`
- `matched_thread_subjects`
- `matched_recipients`
- `error`

If `ok` is false, trust `error.code` and do not fall back to legacy singleton mail bus files unless the helper itself is unavailable.
