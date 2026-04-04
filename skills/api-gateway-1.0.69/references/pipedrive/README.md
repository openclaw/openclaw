# Pipedrive Routing Reference

**App name:** `pipedrive`
**Base URL proxied:** `api.pipedrive.com`

## API Path Pattern

```
/pipedrive/api/v1/{resource}
```

## Common Endpoints

### List Deals

```bash
GET /pipedrive/api/v1/deals?status=open&limit=50
```

### Get Deal

```bash
GET /pipedrive/api/v1/deals/{id}
```

### Create Deal

```bash
POST /pipedrive/api/v1/deals
Content-Type: application/json

{
  "title": "New Enterprise Deal",
  "value": 50000,
  "currency": "USD",
  "person_id": 123,
  "org_id": 456,
  "stage_id": 1,
  "expected_close_date": "2025-06-30"
}
```

### Update Deal

```bash
PUT /pipedrive/api/v1/deals/{id}
Content-Type: application/json

{
  "title": "Updated Deal Title",
  "value": 75000,
  "status": "won"
}
```

### Delete Deal

```bash
DELETE /pipedrive/api/v1/deals/{id}
```

### Search Deals

```bash
GET /pipedrive/api/v1/deals/search?term=enterprise
```

### List Persons

```bash
GET /pipedrive/api/v1/persons
```

### Create Person

```bash
POST /pipedrive/api/v1/persons
Content-Type: application/json

{
  "name": "John Doe",
  "email": ["john@example.com"],
  "phone": ["+1234567890"],
  "org_id": 456
}
```

### List Organizations

```bash
GET /pipedrive/api/v1/organizations
```

### Create Organization

```bash
POST /pipedrive/api/v1/organizations
Content-Type: application/json

{
  "name": "Acme Corporation",
  "address": "123 Main St, City, Country"
}
```

### List Activities

```bash
GET /pipedrive/api/v1/activities?type=call&done=0
```

### Create Activity

```bash
POST /pipedrive/api/v1/activities
Content-Type: application/json

{
  "subject": "Follow-up call",
  "type": "call",
  "due_date": "2025-03-15",
  "due_time": "14:00",
  "deal_id": 789,
  "person_id": 123
}
```

### List Pipelines

```bash
GET /pipedrive/api/v1/pipelines
```

### List Stages

```bash
GET /pipedrive/api/v1/stages?pipeline_id=1
```

### Create Note

```bash
POST /pipedrive/api/v1/notes
Content-Type: application/json

{
  "content": "Meeting notes: Discussed pricing and timeline",
  "deal_id": 789,
  "pinned_to_deal_flag": 1
}
```

### Get Current User

```bash
GET /pipedrive/api/v1/users/me
```

## Notes

- IDs are integers
- Email and phone fields accept arrays for multiple values
- `visible_to` values: 1 (owner only), 3 (entire company), 5 (owner's visibility group), 7 (entire company and visibility group)
- Deal status: `open`, `won`, `lost`, `deleted`
- Use `start` and `limit` for pagination
- Custom fields are supported via their API key (e.g., `abc123_custom_field`)

## Resources

- [Pipedrive API Overview](https://developers.pipedrive.com/docs/api/v1)
- [Deals](https://developers.pipedrive.com/docs/api/v1/Deals)
- [Persons](https://developers.pipedrive.com/docs/api/v1/Persons)
- [Organizations](https://developers.pipedrive.com/docs/api/v1/Organizations)
- [Activities](https://developers.pipedrive.com/docs/api/v1/Activities)
- [Pipelines](https://developers.pipedrive.com/docs/api/v1/Pipelines)
- [Stages](https://developers.pipedrive.com/docs/api/v1/Stages)
- [Notes](https://developers.pipedrive.com/docs/api/v1/Notes)
