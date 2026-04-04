# Instantly Routing Reference

**App name:** `instantly`
**Base URL proxied:** `api.instantly.ai`

## API Path Pattern

```
/instantly/api/v2/{resource}
```

## Common Endpoints

### Campaigns

#### List Campaigns

```bash
GET /instantly/api/v2/campaigns?limit=10
```

#### Get Campaign

```bash
GET /instantly/api/v2/campaigns/{campaign_id}
```

#### Create Campaign

```bash
POST /instantly/api/v2/campaigns
```

#### Activate Campaign

```bash
POST /instantly/api/v2/campaigns/{campaign_id}/activate
```

#### Pause Campaign

```bash
POST /instantly/api/v2/campaigns/{campaign_id}/pause
```

#### Delete Campaign

```bash
DELETE /instantly/api/v2/campaigns/{campaign_id}
```

#### Get Campaign Analytics

```bash
GET /instantly/api/v2/campaigns/analytics?id={campaign_id}
```

### Leads

#### Create Lead

```bash
POST /instantly/api/v2/leads
```

#### List Leads (POST due to complex filtering)

```bash
POST /instantly/api/v2/leads/list
```

#### Get Lead

```bash
GET /instantly/api/v2/leads/{lead_id}
```

#### Delete Lead

```bash
DELETE /instantly/api/v2/leads/{lead_id}
```

### Lead Lists

#### List Lead Lists

```bash
GET /instantly/api/v2/lead-lists?limit=10
```

#### Create Lead List

```bash
POST /instantly/api/v2/lead-lists
```

#### Get Lead List

```bash
GET /instantly/api/v2/lead-lists/{list_id}
```

#### Update Lead List

```bash
PATCH /instantly/api/v2/lead-lists/{list_id}
```

#### Delete Lead List

```bash
DELETE /instantly/api/v2/lead-lists/{list_id}
```

### Accounts (Sending Email Accounts)

#### List Accounts

```bash
GET /instantly/api/v2/accounts?limit=10
```

#### Get Account

```bash
GET /instantly/api/v2/accounts/{email}
```

#### Create Account

```bash
POST /instantly/api/v2/accounts
```

#### Update Account

```bash
PATCH /instantly/api/v2/accounts/{email}
```

#### Delete Account

```bash
DELETE /instantly/api/v2/accounts/{email}
```

#### Enable Warmup

```bash
POST /instantly/api/v2/accounts/warmup/enable
```

#### Disable Warmup

```bash
POST /instantly/api/v2/accounts/warmup/disable
```

### Emails (Unibox)

#### List Emails

```bash
GET /instantly/api/v2/emails?limit=20
```

#### Reply to Email

```bash
POST /instantly/api/v2/emails/reply
```

#### Forward Email

```bash
POST /instantly/api/v2/emails/forward
```

### Block List

#### List Block List Entries

```bash
GET /instantly/api/v2/block-lists-entries?limit=100
```

#### Create Block List Entry

```bash
POST /instantly/api/v2/block-lists-entries
```

#### Delete Block List Entry

```bash
DELETE /instantly/api/v2/block-lists-entries/{entry_id}
```

### Workspace

#### Get Current Workspace

```bash
GET /instantly/api/v2/workspaces/current
```

## Notes

- API v2 uses snake_case for all field names
- Campaign timezone must use Etc/GMT format (e.g., "Etc/GMT+5")
- List Leads is POST (not GET) due to complex filtering
- Cursor-based pagination with `limit` and `starting_after`
- Campaign status: 0=draft, 1=active, 2=paused, 3=completed

## Resources

- [Instantly API V2 Documentation](https://developer.instantly.ai/api/v2)
