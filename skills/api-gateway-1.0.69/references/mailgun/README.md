# Mailgun Routing Reference

**App name:** `mailgun`
**Base URL proxied:** `api.mailgun.net`

## API Path Pattern

```
/mailgun/v3/{resource}
```

## Common Endpoints

### Domains

#### List Domains

```bash
GET /mailgun/v3/domains
```

#### Get Domain

```bash
GET /mailgun/v3/domains/{domain_name}
```

#### Create Domain

```bash
POST /mailgun/v3/domains
```

#### Delete Domain

```bash
DELETE /mailgun/v3/domains/{domain_name}
```

### Messages

#### Send Message

```bash
POST /mailgun/v3/{domain_name}/messages
```

#### Send MIME Message

```bash
POST /mailgun/v3/{domain_name}/messages.mime
```

### Events

#### List Events

```bash
GET /mailgun/v3/{domain_name}/events
```

### Routes

#### List Routes

```bash
GET /mailgun/v3/routes
```

#### Create Route

```bash
POST /mailgun/v3/routes
```

#### Get Route

```bash
GET /mailgun/v3/routes/{route_id}
```

#### Update Route

```bash
PUT /mailgun/v3/routes/{route_id}
```

#### Delete Route

```bash
DELETE /mailgun/v3/routes/{route_id}
```

### Webhooks

#### List Webhooks

```bash
GET /mailgun/v3/domains/{domain_name}/webhooks
```

#### Create Webhook

```bash
POST /mailgun/v3/domains/{domain_name}/webhooks
```

#### Get Webhook

```bash
GET /mailgun/v3/domains/{domain_name}/webhooks/{webhook_type}
```

#### Update Webhook

```bash
PUT /mailgun/v3/domains/{domain_name}/webhooks/{webhook_type}
```

#### Delete Webhook

```bash
DELETE /mailgun/v3/domains/{domain_name}/webhooks/{webhook_type}
```

### Templates

#### List Templates

```bash
GET /mailgun/v3/{domain_name}/templates
```

#### Create Template

```bash
POST /mailgun/v3/{domain_name}/templates
```

#### Get Template

```bash
GET /mailgun/v3/{domain_name}/templates/{template_name}
```

#### Delete Template

```bash
DELETE /mailgun/v3/{domain_name}/templates/{template_name}
```

### Mailing Lists

#### List Mailing Lists

```bash
GET /mailgun/v3/lists/pages
```

#### Create Mailing List

```bash
POST /mailgun/v3/lists
```

#### Get Mailing List

```bash
GET /mailgun/v3/lists/{list_address}
```

#### Update Mailing List

```bash
PUT /mailgun/v3/lists/{list_address}
```

#### Delete Mailing List

```bash
DELETE /mailgun/v3/lists/{list_address}
```

### Mailing List Members

#### List Members

```bash
GET /mailgun/v3/lists/{list_address}/members/pages
```

#### Add Member

```bash
POST /mailgun/v3/lists/{list_address}/members
```

#### Get Member

```bash
GET /mailgun/v3/lists/{list_address}/members/{member_address}
```

#### Update Member

```bash
PUT /mailgun/v3/lists/{list_address}/members/{member_address}
```

#### Delete Member

```bash
DELETE /mailgun/v3/lists/{list_address}/members/{member_address}
```

### Suppressions

#### Bounces

```bash
GET /mailgun/v3/{domain_name}/bounces
POST /mailgun/v3/{domain_name}/bounces
GET /mailgun/v3/{domain_name}/bounces/{address}
DELETE /mailgun/v3/{domain_name}/bounces/{address}
```

#### Unsubscribes

```bash
GET /mailgun/v3/{domain_name}/unsubscribes
POST /mailgun/v3/{domain_name}/unsubscribes
DELETE /mailgun/v3/{domain_name}/unsubscribes/{address}
```

#### Complaints

```bash
GET /mailgun/v3/{domain_name}/complaints
POST /mailgun/v3/{domain_name}/complaints
DELETE /mailgun/v3/{domain_name}/complaints/{address}
```

#### Whitelists

```bash
GET /mailgun/v3/{domain_name}/whitelists
POST /mailgun/v3/{domain_name}/whitelists
DELETE /mailgun/v3/{domain_name}/whitelists/{address}
```

### Statistics

#### Get Stats

```bash
GET /mailgun/v3/{domain_name}/stats/total?event=delivered
```

### Tags

#### List Tags

```bash
GET /mailgun/v3/{domain_name}/tags
```

#### Get Tag

```bash
GET /mailgun/v3/{domain_name}/tags/{tag_name}
```

#### Delete Tag

```bash
DELETE /mailgun/v3/{domain_name}/tags/{tag_name}
```

### IPs

#### List IPs

```bash
GET /mailgun/v3/ips
```

#### Get IP

```bash
GET /mailgun/v3/ips/{ip_address}
```

### Domain Tracking

#### Get Tracking Settings

```bash
GET /mailgun/v3/domains/{domain_name}/tracking
```

#### Update Tracking

```bash
PUT /mailgun/v3/domains/{domain_name}/tracking/open
PUT /mailgun/v3/domains/{domain_name}/tracking/click
PUT /mailgun/v3/domains/{domain_name}/tracking/unsubscribe
```

### Credentials

#### List Credentials

```bash
GET /mailgun/v3/domains/{domain_name}/credentials
```

#### Create Credential

```bash
POST /mailgun/v3/domains/{domain_name}/credentials
```

#### Delete Credential

```bash
DELETE /mailgun/v3/domains/{domain_name}/credentials/{login}
```

## Notes

- Mailgun uses `application/x-www-form-urlencoded` for POST/PUT requests, not JSON
- Routes are global (per account), not per domain
- Sandbox domains require authorized recipients
- Event logs stored for at least 3 days
- Stats require at least one `event` parameter
- US region: api.mailgun.net, EU region: api.eu.mailgun.net

## Resources

- [Mailgun API Documentation](https://documentation.mailgun.com/docs/mailgun/api-reference/api-overview)
