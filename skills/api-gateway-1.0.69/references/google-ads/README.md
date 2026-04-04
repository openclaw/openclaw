# Google Ads Routing Reference

**App name:** `google-ads`
**Base URL proxied:** `googleads.googleapis.com`

## API Path Pattern

```
/google-ads/v23/customers/{customerId}/{endpoint}
```

## Common Endpoints

### List Accessible Customers

```bash
GET /google-ads/v23/customers:listAccessibleCustomers
```

### Search (GAQL Query)

```bash
POST /google-ads/v23/customers/{customerId}/googleAds:search
Content-Type: application/json

{
  "query": "SELECT campaign.id, campaign.name, campaign.status FROM campaign ORDER BY campaign.id"
}
```

### Search Stream (for large result sets)

```bash
POST /google-ads/v23/customers/{customerId}/googleAds:searchStream
Content-Type: application/json

{
  "query": "SELECT campaign.id, campaign.name FROM campaign"
}
```

## Common GAQL Queries

### List Campaigns

```sql
SELECT
  campaign.id,
  campaign.name,
  campaign.status,
  campaign.advertising_channel_type
FROM campaign
WHERE campaign.status != 'REMOVED'
ORDER BY campaign.name
```

### Campaign Performance

```sql
SELECT
  campaign.id,
  campaign.name,
  metrics.impressions,
  metrics.clicks,
  metrics.cost_micros,
  metrics.conversions
FROM campaign
WHERE segments.date DURING LAST_30_DAYS
ORDER BY metrics.impressions DESC
```

### List Ad Groups

```sql
SELECT
  ad_group.id,
  ad_group.name,
  ad_group.status,
  campaign.id,
  campaign.name
FROM ad_group
WHERE ad_group.status != 'REMOVED'
```

### Ad Group Performance

```sql
SELECT
  ad_group.id,
  ad_group.name,
  metrics.impressions,
  metrics.clicks,
  metrics.average_cpc
FROM ad_group
WHERE segments.date DURING LAST_7_DAYS
```

### List Keywords

```sql
SELECT
  ad_group_criterion.keyword.text,
  ad_group_criterion.keyword.match_type,
  ad_group_criterion.status,
  metrics.impressions,
  metrics.clicks
FROM keyword_view
WHERE segments.date DURING LAST_30_DAYS
```

### List Ads

```sql
SELECT
  ad_group_ad.ad.id,
  ad_group_ad.ad.name,
  ad_group_ad.status,
  ad_group_ad.ad.type
FROM ad_group_ad
WHERE ad_group_ad.status != 'REMOVED'
```

## Mutate Operations

### Create Campaign

```bash
POST /google-ads/v23/customers/{customerId}/campaigns:mutate
Content-Type: application/json

{
  "operations": [
    {
      "create": {
        "name": "New Campaign",
        "advertisingChannelType": "SEARCH",
        "status": "PAUSED",
        "manualCpc": {},
        "campaignBudget": "customers/{customerId}/campaignBudgets/{budgetId}"
      }
    }
  ]
}
```

### Update Campaign Status

```bash
POST /google-ads/v23/customers/{customerId}/campaigns:mutate
Content-Type: application/json

{
  "operations": [
    {
      "update": {
        "resourceName": "customers/{customerId}/campaigns/{campaignId}",
        "status": "ENABLED"
      },
      "updateMask": "status"
    }
  ]
}
```

## Notes

- Authentication is automatic - the router injects OAuth token and developer-token headers
- Use `listAccessibleCustomers` first to get available customer IDs
- Customer IDs are 10-digit numbers (remove dashes if formatted as XXX-XXX-XXXX)
- Monetary values are in micros (divide by 1,000,000)
- Use GAQL (Google Ads Query Language) for querying
- Date ranges: `LAST_7_DAYS`, `LAST_30_DAYS`, `THIS_MONTH`, etc.
- Status values: `ENABLED`, `PAUSED`, `REMOVED`
- API version updates frequently - check release notes for latest (currently v23)

## Resources

- [API Overview](https://developers.google.com/google-ads/api/docs/start)
- [List Accessible Customers](https://developers.google.com/google-ads/api/reference/rpc/v23/CustomerService/ListAccessibleCustomers?transport=rest)
- [Search](https://developers.google.com/google-ads/api/reference/rpc/v23/GoogleAdsService/Search?transport=rest)
- [Search Stream](https://developers.google.com/google-ads/api/reference/rpc/v23/GoogleAdsService/SearchStream?transport=rest)
- [GAQL Reference](https://developers.google.com/google-ads/api/docs/query/overview)
- [Metrics Reference](https://developers.google.com/google-ads/api/fields/v23/metrics)
