# Fathom Routing Reference

**App name:** `fathom`
**Base URL proxied:** `api.fathom.ai`

## API Path Pattern

```
/fathom/external/v1/{resource}
```

## Common Endpoints

### List Meetings

```bash
GET /fathom/external/v1/meetings
```

With filters:

```bash
GET /fathom/external/v1/meetings?created_after=2025-01-01T00:00:00Z&teams[]=Sales
```

### Get Summary

```bash
GET /fathom/external/v1/recordings/{recording_id}/summary
```

Async callback:

```bash
GET /fathom/external/v1/recordings/{recording_id}/summary?destination_url=https://example.com/webhook
```

### Get Transcript

```bash
GET /fathom/external/v1/recordings/{recording_id}/transcript
```

Async callback:

```bash
GET /fathom/external/v1/recordings/{recording_id}/transcript?destination_url=https://example.com/webhook
```

### List Teams

```bash
GET /fathom/external/v1/teams
```

### List Team Members

```bash
GET /fathom/external/v1/team_members?team=Sales
```

### Create Webhook

```bash
POST /fathom/external/v1/webhooks
Content-Type: application/json

{
  "destination_url": "https://example.com/webhook",
  "triggered_for": ["my_recordings", "my_shared_with_team_recordings"],
  "include_transcript": true,
  "include_summary": true,
  "include_action_items": true
}
```

### Delete Webhook

```bash
DELETE /fathom/external/v1/webhooks/{id}
```

## Notes

- Recording IDs are integers
- Timestamps are in ISO 8601 format
- OAuth users cannot use inline transcript/summary parameters on `/meetings` endpoint - use dedicated `/recordings/{id}/summary` and `/recordings/{id}/transcript` endpoints instead
- Use cursor-based pagination with `cursor` parameter
- Webhook `triggered_for` options: `my_recordings`, `shared_external_recordings`, `my_shared_with_team_recordings`, `shared_team_recordings`
- Webhook secrets are used to verify webhook signatures

## Resources

- [Fathom API Documentation](https://developers.fathom.ai)
- [LLM Reference](https://developers.fathom.ai/llms.txt)
