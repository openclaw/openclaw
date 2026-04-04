# Google Search Console Routing Reference

**App name:** `google-search-console`
**Base URL proxied:** `www.googleapis.com`

## API Path Pattern

```
/google-search-console/webmasters/v3/{endpoint}
```

## Common Endpoints

### List Sites

```bash
GET /google-search-console/webmasters/v3/sites
```

### Get Site

```bash
GET /google-search-console/webmasters/v3/sites/{siteUrl}
```

Note: Site URL must be URL-encoded (e.g., `https%3A%2F%2Fexample.com%2F`)

### Search Analytics Query

```bash
POST /google-search-console/webmasters/v3/sites/{siteUrl}/searchAnalytics/query
Content-Type: application/json

{
  "startDate": "2024-01-01",
  "endDate": "2024-01-31",
  "dimensions": ["query"],
  "rowLimit": 100
}
```

### List Sitemaps

```bash
GET /google-search-console/webmasters/v3/sites/{siteUrl}/sitemaps
```

### Get Sitemap

```bash
GET /google-search-console/webmasters/v3/sites/{siteUrl}/sitemaps/{feedpath}
```

### Submit Sitemap

```bash
PUT /google-search-console/webmasters/v3/sites/{siteUrl}/sitemaps/{feedpath}
```

### Delete Sitemap

```bash
DELETE /google-search-console/webmasters/v3/sites/{siteUrl}/sitemaps/{feedpath}
```

## Search Analytics Query Examples

### Top Queries

```json
{
  "startDate": "2024-01-01",
  "endDate": "2024-01-31",
  "dimensions": ["query"],
  "rowLimit": 25,
  "startRow": 0
}
```

### Top Pages

```json
{
  "startDate": "2024-01-01",
  "endDate": "2024-01-31",
  "dimensions": ["page"],
  "rowLimit": 25
}
```

### Queries by Country

```json
{
  "startDate": "2024-01-01",
  "endDate": "2024-01-31",
  "dimensions": ["query", "country"],
  "rowLimit": 100
}
```

### Device Breakdown

```json
{
  "startDate": "2024-01-01",
  "endDate": "2024-01-31",
  "dimensions": ["device"],
  "rowLimit": 10
}
```

### Daily Performance

```json
{
  "startDate": "2024-01-01",
  "endDate": "2024-01-31",
  "dimensions": ["date"],
  "rowLimit": 31
}
```

### Filtered Query

```json
{
  "startDate": "2024-01-01",
  "endDate": "2024-01-31",
  "dimensions": ["query"],
  "dimensionFilterGroups": [
    {
      "filters": [
        {
          "dimension": "query",
          "operator": "contains",
          "expression": "keyword"
        }
      ]
    }
  ],
  "rowLimit": 100
}
```

### Search Type Filter

```json
{
  "startDate": "2024-01-01",
  "endDate": "2024-01-31",
  "dimensions": ["query"],
  "type": "image",
  "rowLimit": 25
}
```

## Dimensions

- `query` - Search query
- `page` - Page URL
- `country` - Country code (ISO 3166-1 alpha-3)
- `device` - DESKTOP, MOBILE, TABLET
- `date` - Date in YYYY-MM-DD format
- `searchAppearance` - Rich result types

## Metrics (returned automatically)

- `clicks` - Number of clicks
- `impressions` - Number of impressions
- `ctr` - Click-through rate
- `position` - Average position

## Filter Operators

- `equals`
- `contains`
- `notContains`
- `includingRegex`
- `excludingRegex`

## Search Types

- `web` - Web search (default)
- `image` - Image search
- `video` - Video search
- `news` - News search

## Notes

- Authentication is automatic - the router injects the OAuth token
- Site URLs must be URL-encoded in the path (e.g., `sc-domain%3Aexample.com`)
- Date range is limited to 16 months of data
- Maximum 25,000 rows per request
- Use `startRow` for pagination
- Data has a 2-3 day delay

## Resources

- [API Reference](https://developers.google.com/webmaster-tools/v1/api_reference_index)
- [List Sites](https://developers.google.com/webmaster-tools/v1/sites/list)
- [Get Site](https://developers.google.com/webmaster-tools/v1/sites/get)
- [Search Analytics Query](https://developers.google.com/webmaster-tools/v1/searchanalytics/query)
- [List Sitemaps](https://developers.google.com/webmaster-tools/v1/sitemaps/list)
- [Get Sitemap](https://developers.google.com/webmaster-tools/v1/sitemaps/get)
- [Submit Sitemap](https://developers.google.com/webmaster-tools/v1/sitemaps/submit)
- [Delete Sitemap](https://developers.google.com/webmaster-tools/v1/sitemaps/delete)
