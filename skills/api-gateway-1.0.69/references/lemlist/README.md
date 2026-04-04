# Lemlist Routing Reference

**App name:** `lemlist`
**Base URL proxied:** `api.lemlist.com`

## API Path Pattern

```
/lemlist/api/{resource}
```

## Common Endpoints

### Team

#### Get Team

```bash
GET /lemlist/api/team
```

#### Get Team Credits

```bash
GET /lemlist/api/team/credits
```

#### Get Team Senders

```bash
GET /lemlist/api/team/senders
```

### Campaigns

#### List Campaigns

```bash
GET /lemlist/api/campaigns
```

#### Create Campaign

```bash
POST /lemlist/api/campaigns
```

#### Get Campaign

```bash
GET /lemlist/api/campaigns/{campaignId}
```

#### Update Campaign

```bash
PATCH /lemlist/api/campaigns/{campaignId}
```

#### Pause Campaign

```bash
POST /lemlist/api/campaigns/{campaignId}/pause
```

### Campaign Sequences

#### Get Campaign Sequences

```bash
GET /lemlist/api/campaigns/{campaignId}/sequences
```

### Campaign Schedules

#### Get Campaign Schedules

```bash
GET /lemlist/api/campaigns/{campaignId}/schedules
```

### Leads

#### Add Lead to Campaign

```bash
POST /lemlist/api/campaigns/{campaignId}/leads
```

#### Get Lead by Email

```bash
GET /lemlist/api/leads/{email}
```

#### Update Lead in Campaign

```bash
PATCH /lemlist/api/campaigns/{campaignId}/leads/{email}
```

#### Delete Lead from Campaign

```bash
DELETE /lemlist/api/campaigns/{campaignId}/leads/{email}
```

### Activities

#### List Activities

```bash
GET /lemlist/api/activities
```

Query parameters:

- `campaignId` - Filter by campaign
- `type` - Filter by activity type

### Schedules

#### List Schedules

```bash
GET /lemlist/api/schedules
```

#### Create Schedule

```bash
POST /lemlist/api/schedules
```

#### Get Schedule

```bash
GET /lemlist/api/schedules/{scheduleId}
```

#### Update Schedule

```bash
PATCH /lemlist/api/schedules/{scheduleId}
```

#### Delete Schedule

```bash
DELETE /lemlist/api/schedules/{scheduleId}
```

### Companies

#### List Companies

```bash
GET /lemlist/api/companies
```

### Unsubscribes

#### List Unsubscribes

```bash
GET /lemlist/api/unsubscribes
```

#### Add Unsubscribe

```bash
POST /lemlist/api/unsubscribes
```

### Inbox Labels

#### List Labels

```bash
GET /lemlist/api/inbox/labels
```

## Notes

- Campaign IDs start with `cam_`
- Lead IDs start with `lea_`
- Schedule IDs start with `skd_`
- Campaigns cannot be deleted via API (only paused)
- Lead emails are used as identifiers for lead operations
- Rate limit: 20 requests per 2 seconds per API key

## Resources

- [Lemlist API Documentation](https://developer.lemlist.com/)
