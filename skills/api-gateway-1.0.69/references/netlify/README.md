# Netlify Routing Reference

**App name:** `netlify`
**Base URL proxied:** `api.netlify.com`

## API Path Pattern

```
/netlify/api/v1/{resource}
```

## Common Endpoints

### User

```bash
GET /netlify/api/v1/user
```

### Accounts

```bash
GET /netlify/api/v1/accounts
GET /netlify/api/v1/accounts/{account_id}
POST /netlify/api/v1/accounts
PUT /netlify/api/v1/accounts/{account_id}
```

### Sites

```bash
GET /netlify/api/v1/sites
GET /netlify/api/v1/sites/{site_id}
POST /netlify/api/v1/sites
PUT /netlify/api/v1/sites/{site_id}
DELETE /netlify/api/v1/sites/{site_id}
PUT /netlify/api/v1/sites/{site_id}/disable
PUT /netlify/api/v1/sites/{site_id}/enable
GET /netlify/api/v1/{account_slug}/sites
POST /netlify/api/v1/{account_slug}/sites
```

### Deploys

```bash
GET /netlify/api/v1/sites/{site_id}/deploys
GET /netlify/api/v1/deploys/{deploy_id}
POST /netlify/api/v1/sites/{site_id}/deploys
POST /netlify/api/v1/sites/{site_id}/deploys/{deploy_id}/cancel
POST /netlify/api/v1/sites/{site_id}/deploys/{deploy_id}/restore
POST /netlify/api/v1/deploys/{deploy_id}/lock
POST /netlify/api/v1/deploys/{deploy_id}/unlock
```

### Builds

```bash
GET /netlify/api/v1/sites/{site_id}/builds
GET /netlify/api/v1/builds/{build_id}
POST /netlify/api/v1/sites/{site_id}/builds
```

### Environment Variables

Environment variables are managed at the account level with optional site scope.

```bash
GET /netlify/api/v1/accounts/{account_id}/env?site_id={site_id}
POST /netlify/api/v1/accounts/{account_id}/env?site_id={site_id}
PUT /netlify/api/v1/accounts/{account_id}/env/{key}?site_id={site_id}
DELETE /netlify/api/v1/accounts/{account_id}/env/{key}?site_id={site_id}
```

### DNS Zones

```bash
GET /netlify/api/v1/dns_zones
GET /netlify/api/v1/dns_zones/{zone_id}
POST /netlify/api/v1/dns_zones
DELETE /netlify/api/v1/dns_zones/{zone_id}
```

### DNS Records

```bash
GET /netlify/api/v1/dns_zones/{zone_id}/dns_records
POST /netlify/api/v1/dns_zones/{zone_id}/dns_records
DELETE /netlify/api/v1/dns_zones/{zone_id}/dns_records/{record_id}
```

### Build Hooks

```bash
GET /netlify/api/v1/sites/{site_id}/build_hooks
POST /netlify/api/v1/sites/{site_id}/build_hooks
DELETE /netlify/api/v1/hooks/{hook_id}
```

### Webhooks

```bash
GET /netlify/api/v1/hooks?site_id={site_id}
POST /netlify/api/v1/hooks?site_id={site_id}
PUT /netlify/api/v1/hooks/{hook_id}
DELETE /netlify/api/v1/hooks/{hook_id}
```

### Forms & Submissions

```bash
GET /netlify/api/v1/sites/{site_id}/forms
GET /netlify/api/v1/forms/{form_id}/submissions
DELETE /netlify/api/v1/submissions/{submission_id}
```

### Team Members

```bash
GET /netlify/api/v1/{account_slug}/members
POST /netlify/api/v1/{account_slug}/members
GET /netlify/api/v1/{account_slug}/members/{member_id}
PUT /netlify/api/v1/{account_slug}/members/{member_id}
DELETE /netlify/api/v1/{account_slug}/members/{member_id}
```

### SSL/TLS

```bash
GET /netlify/api/v1/sites/{site_id}/ssl
POST /netlify/api/v1/sites/{site_id}/ssl
```

### Functions

```bash
GET /netlify/api/v1/sites/{site_id}/functions
```

### Services

```bash
GET /netlify/api/v1/services
GET /netlify/api/v1/services/{service_id}
```

## Notes

- All endpoints use the `/api/v1/` prefix
- Site IDs are UUIDs (e.g., `d37d1ce4-5444-40f5-a4ca-a2c40a8b6835`)
- Account slugs are URL-friendly team names (e.g., `my-team-slug`)
- Pagination via `page` and `per_page` query parameters
- Environment variable contexts: `all`, `production`, `deploy-preview`, `branch-deploy`, `dev`
- Build hooks return a URL that can be POSTed to trigger builds externally

## Resources

- [Netlify API Documentation](https://docs.netlify.com/api/get-started/)
- [Netlify OpenAPI Spec](https://open-api.netlify.com)
