# CallRail Routing Reference

**App name:** `callrail`
**Base URL proxied:** `api.callrail.com`

## API Path Pattern

```
/callrail/v3/a/{account_id}/{resource}.json
```

**Important:** All CallRail API endpoints end with `.json`. Account IDs start with `ACC`.

## Common Endpoints

### Accounts

#### List Accounts

```bash
GET /callrail/v3/a.json
```

#### Get Account

```bash
GET /callrail/v3/a/{account_id}.json
```

### Companies

#### List Companies

```bash
GET /callrail/v3/a/{account_id}/companies.json
```

#### Get Company

```bash
GET /callrail/v3/a/{account_id}/companies/{company_id}.json
```

### Calls

#### List Calls

```bash
GET /callrail/v3/a/{account_id}/calls.json
```

Query parameters: `page`, `per_page`, `date_range`, `start_date`, `end_date`, `company_id`, `tracker_id`, `search`, `fields`, `sort`, `order`

#### Get Call

```bash
GET /callrail/v3/a/{account_id}/calls/{call_id}.json
```

#### Update Call

```bash
PUT /callrail/v3/a/{account_id}/calls/{call_id}.json
Content-Type: application/json

{
  "customer_name": "John Smith",
  "note": "Follow up scheduled",
  "lead_status": "good_lead"
}
```

#### Call Summary

```bash
GET /callrail/v3/a/{account_id}/calls/summary.json
```

#### Call Timeseries

```bash
GET /callrail/v3/a/{account_id}/calls/timeseries.json
```

### Trackers

#### List Trackers

```bash
GET /callrail/v3/a/{account_id}/trackers.json
```

#### Get Tracker

```bash
GET /callrail/v3/a/{account_id}/trackers/{tracker_id}.json
```

### Tags

#### List Tags

```bash
GET /callrail/v3/a/{account_id}/tags.json
```

#### Create Tag

```bash
POST /callrail/v3/a/{account_id}/tags.json
Content-Type: application/json

{
  "name": "New Tag",
  "tag_level": "account",
  "color": "blue1"
}
```

#### Update Tag

```bash
PUT /callrail/v3/a/{account_id}/tags/{tag_id}.json
Content-Type: application/json

{
  "name": "Updated Name",
  "color": "green1"
}
```

#### Delete Tag

```bash
DELETE /callrail/v3/a/{account_id}/tags/{tag_id}.json
```

### Users

#### List Users

```bash
GET /callrail/v3/a/{account_id}/users.json
```

#### Get User

```bash
GET /callrail/v3/a/{account_id}/users/{user_id}.json
```

### Integrations

#### List Integrations

```bash
GET /callrail/v3/a/{account_id}/integrations.json?company_id={company_id}
```

### Notifications

#### List Notifications

```bash
GET /callrail/v3/a/{account_id}/notifications.json
```

## ID Prefixes

- Account IDs: `ACC`
- Company IDs: `COM`
- Call IDs: `CAL`
- Tracker IDs: `TRK`
- User IDs: `USR`

## Pagination

Uses offset-based pagination with `page` and `per_page` parameters:

```bash
GET /callrail/v3/a/{account_id}/calls.json?page=2&per_page=50
# Response includes page, per_page, total_pages, total_records
```

For calls endpoint, relative pagination is available via `relative_pagination=true`.

## Notes

- All endpoints end with `.json`
- Communication records retained for 25 months
- Rate limits: 1,000/hour, 10,000/day for general API
- ISO 8601 date format with timezone

## Resources

- [CallRail API Documentation](https://apidocs.callrail.com/)
- [CallRail Help Center - API](https://support.callrail.com/hc/en-us/sections/4426797289229-API)
