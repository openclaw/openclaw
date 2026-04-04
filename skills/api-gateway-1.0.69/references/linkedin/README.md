# LinkedIn Routing Reference

**App name:** `linkedin`
**Base URL proxied:** `api.linkedin.com`

## API Path Pattern

```
/linkedin/rest/{resource}
```

## Required Headers

```
LinkedIn-Version: 202506
```

## Common Endpoints

### Get Current User Profile

```bash
GET /linkedin/rest/me
LinkedIn-Version: 202506
```

### Create Text Post

```bash
POST /linkedin/rest/posts
Content-Type: application/json
LinkedIn-Version: 202506

{
  "author": "urn:li:person:{personId}",
  "lifecycleState": "PUBLISHED",
  "visibility": "PUBLIC",
  "commentary": "Hello LinkedIn!",
  "distribution": {
    "feedDistribution": "MAIN_FEED"
  }
}
```

### Create Article/URL Share

```bash
POST /linkedin/rest/posts
Content-Type: application/json
LinkedIn-Version: 202506

{
  "author": "urn:li:person:{personId}",
  "lifecycleState": "PUBLISHED",
  "visibility": "PUBLIC",
  "commentary": "Check this out!",
  "distribution": {
    "feedDistribution": "MAIN_FEED"
  },
  "content": {
    "article": {
      "source": "https://example.com",
      "title": "Title",
      "description": "Description"
    }
  }
}
```

### Initialize Image Upload

```bash
POST /linkedin/rest/images?action=initializeUpload
Content-Type: application/json
LinkedIn-Version: 202506

{
  "initializeUploadRequest": {
    "owner": "urn:li:person:{personId}"
  }
}
```

### Ad Library - Search Ads

```bash
GET /linkedin/rest/adLibrary?q=criteria&keyword=linkedin
LinkedIn-Version: 202506
```

### Job Library - Search Jobs

```bash
GET /linkedin/rest/jobLibrary?q=criteria&keyword=software
LinkedIn-Version: 202506
```

## Marketing API (Advertising)

Required headers for all Marketing API calls:

```
LinkedIn-Version: 202506
```

### List Ad Accounts

```bash
GET /linkedin/rest/adAccounts?q=search
```

### Get Ad Account

```bash
GET /linkedin/rest/adAccounts/{adAccountId}
```

### Create Ad Account

```bash
POST /linkedin/rest/adAccounts
Content-Type: application/json

{
  "name": "Ad Account Name",
  "currency": "USD",
  "reference": "urn:li:organization:{orgId}",
  "type": "BUSINESS"
}
```

### List Campaign Groups

```bash
GET /linkedin/rest/adAccounts/{adAccountId}/adCampaignGroups
```

### Create Campaign Group

```bash
POST /linkedin/rest/adAccounts/{adAccountId}/adCampaignGroups
Content-Type: application/json

{
  "name": "Campaign Group Name",
  "status": "DRAFT"
}
```

### Get Campaign Group

```bash
GET /linkedin/rest/adAccounts/{adAccountId}/adCampaignGroups/{campaignGroupId}
```

### List Campaigns

```bash
GET /linkedin/rest/adAccounts/{adAccountId}/adCampaigns
```

### Create Campaign

```bash
POST /linkedin/rest/adAccounts/{adAccountId}/adCampaigns
Content-Type: application/json

{
  "campaignGroup": "urn:li:sponsoredCampaignGroup:{groupId}",
  "name": "Campaign Name",
  "status": "DRAFT",
  "objectiveType": "BRAND_AWARENESS"
}
```

### Get Campaign

```bash
GET /linkedin/rest/adAccounts/{adAccountId}/adCampaigns/{campaignId}
```

### List Organization ACLs

```bash
GET /linkedin/rest/organizationAcls?q=roleAssignee
LinkedIn-Version: 202506
```

### Lookup Organization by Vanity Name

```bash
GET /linkedin/rest/organizations?q=vanityName&vanityName=microsoft
```

### Get Organization Share Statistics

```bash
GET /linkedin/rest/organizationalEntityShareStatistics?q=organizationalEntity&organizationalEntity=urn:li:organization:12345
```

### Get Organization Posts

```bash
GET /linkedin/rest/posts?q=author&author=urn:li:organization:12345
```

## Media Upload

### Initialize Image Upload

```bash
POST /linkedin/rest/images?action=initializeUpload
Content-Type: application/json
LinkedIn-Version: 202506

{"initializeUploadRequest": {"owner": "urn:li:person:{personId}"}}
```

### Initialize Video Upload

```bash
POST /linkedin/rest/videos?action=initializeUpload
Content-Type: application/json
LinkedIn-Version: 202506

{"initializeUploadRequest": {"owner": "urn:li:person:{personId}", "fileSizeBytes": 10000000}}
```

### Initialize Document Upload

```bash
POST /linkedin/rest/documents?action=initializeUpload
Content-Type: application/json
LinkedIn-Version: 202506

{"initializeUploadRequest": {"owner": "urn:li:person:{personId}"}}
```

## Ad Targeting

### Get Targeting Facets

```bash
GET /linkedin/rest/adTargetingFacets
LinkedIn-Version: 202506
```

Returns 31 targeting facets (skills, industries, titles, locations, etc.)

## Notes

- Authentication is automatic - the router injects the OAuth token
- Include `LinkedIn-Version: 202506` header for all REST API calls
- Author URN format: `urn:li:person:{personId}`
- Get person ID from `/rest/me` endpoint
- Image uploads are 3-step: initialize, upload binary, create post
- Rate limits: 150 requests/day per member, 100K/day per app

## Visibility Options

- `PUBLIC` - Viewable by anyone
- `CONNECTIONS` - 1st-degree connections only

## Share Media Categories

- `NONE` - Text only
- `ARTICLE` - URL share
- `IMAGE` - Image post
- `VIDEO` - Video post

## Resources

- [LinkedIn API Overview](https://learn.microsoft.com/en-us/linkedin/)
- [Share on LinkedIn](https://learn.microsoft.com/en-us/linkedin/consumer/integrations/self-serve/share-on-linkedin)
- [Profile API](https://learn.microsoft.com/en-us/linkedin/shared/integrations/people/profile-api)
- [Marketing API](https://learn.microsoft.com/en-us/linkedin/marketing/)
- [Ad Accounts](https://learn.microsoft.com/en-us/linkedin/marketing/integrations/ads/account-structure/create-and-manage-accounts)
- [Campaigns](https://learn.microsoft.com/en-us/linkedin/marketing/integrations/ads/account-structure/create-and-manage-campaigns)
