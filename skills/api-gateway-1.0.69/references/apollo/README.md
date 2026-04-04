# Apollo Routing Reference

**App name:** `apollo`
**Base URL proxied:** `api.apollo.io`

## API Path Pattern

```
/apollo/v1/{endpoint}
```

## Common Endpoints

### People

#### Search People

```bash
POST /apollo/v1/mixed_people/api_search
Content-Type: application/json

{
  "q_organization_name": "Google",
  "page": 1,
  "per_page": 25
}
```

#### Get Person

```bash
GET /apollo/v1/people/{personId}
```

#### Enrich Person

```bash
POST /apollo/v1/people/match
Content-Type: application/json

{
  "email": "john@example.com"
}
```

Or by LinkedIn:

```bash
POST /apollo/v1/people/match
Content-Type: application/json

{
  "linkedin_url": "https://linkedin.com/in/johndoe"
}
```

### Organizations

#### Search Organizations

```bash
POST /apollo/v1/organizations/search
Content-Type: application/json

{
  "q_organization_name": "Google",
  "page": 1,
  "per_page": 25
}
```

#### Enrich Organization

```bash
POST /apollo/v1/organizations/enrich
Content-Type: application/json

{
  "domain": "google.com"
}
```

### Contacts

#### Search Contacts

```bash
POST /apollo/v1/contacts/search
Content-Type: application/json

{
  "page": 1,
  "per_page": 25
}
```

#### Create Contact

```bash
POST /apollo/v1/contacts
Content-Type: application/json

{
  "first_name": "John",
  "last_name": "Doe",
  "email": "john@example.com",
  "organization_name": "Acme Corp"
}
```

#### Update Contact

```bash
PUT /apollo/v1/contacts/{contactId}
Content-Type: application/json

{
  "first_name": "Jane"
}
```

### Accounts

#### Search Accounts

```bash
POST /apollo/v1/accounts/search
Content-Type: application/json

{
  "page": 1,
  "per_page": 25
}
```

#### Create Account

```bash
POST /apollo/v1/accounts
Content-Type: application/json

{
  "name": "Acme Corp",
  "domain": "acme.com"
}
```

### Sequences

#### Search Sequences

```bash
POST /apollo/v1/emailer_campaigns/search
Content-Type: application/json

{
  "page": 1,
  "per_page": 25
}
```

#### Add Contact to Sequence

```bash
POST /apollo/v1/emailer_campaigns/{campaignId}/add_contact_ids
Content-Type: application/json

{
  "contact_ids": ["contact_id_1", "contact_id_2"]
}
```

### Email

#### Search Email Messages

```bash
POST /apollo/v1/emailer_messages/search
Content-Type: application/json

{
  "contact_id": "{contactId}"
}
```

### Labels

#### List Labels

```bash
GET /apollo/v1/labels
```

## Search Filters

Common search parameters:

- `q_organization_name` - Company name
- `q_person_title` - Job title
- `person_locations` - Array of locations
- `organization_num_employees_ranges` - Employee count ranges
- `q_keywords` - General keyword search

## Notes

- Authentication is automatic - the router injects the API key
- Pagination uses `page` and `per_page` parameters in POST body
- Most list endpoints use POST with `/search` suffix (not GET)
- Email enrichment consumes credits
- Rate limits apply per endpoint
- `people/search` and `mixed_people/search` are deprecated - use `mixed_people/api_search` instead

## Resources

- [API Overview](https://docs.apollo.io/reference/introduction)
- [Search People](https://docs.apollo.io/reference/people-api-search.md)
- [Enrich Person](https://docs.apollo.io/reference/people-enrichment.md)
- [Search Organizations](https://docs.apollo.io/reference/organization-search.md)
- [Enrich Organization](https://docs.apollo.io/reference/organization-enrichment.md)
- [Search Contacts](https://docs.apollo.io/reference/search-for-contacts.md)
- [Create Contact](https://docs.apollo.io/reference/create-a-contact.md)
- [Update Contact](https://docs.apollo.io/reference/update-a-contact.md)
- [Search Accounts](https://docs.apollo.io/reference/search-for-accounts.md)
- [Create Account](https://docs.apollo.io/reference/create-an-account.md)
- [Search Sequences](https://docs.apollo.io/reference/search-for-sequences.md)
- [Add Contacts to Sequence](https://docs.apollo.io/reference/add-contacts-to-sequence.md)
- [Search Email Messages](https://docs.apollo.io/reference/search-for-outreach-emails.md)
- [List Labels](https://docs.apollo.io/reference/get-a-list-of-all-lists.md)
- [LLM Reference](https://docs.apollo.io/llms.txt)
