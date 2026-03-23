---
name: linkedin
description: |
  LinkedIn API integration with managed OAuth. Share posts, manage profile, run ads, and access LinkedIn features.
  Use this skill when users want to share content on LinkedIn, manage ad campaigns, get profile/organization information, or interact with LinkedIn's platform.
  For other third party apps, use the api-gateway skill (https://clawhub.ai/byungkyu/api-gateway).
  Requires network access and valid Maton API key.
metadata:
  author: maton
  version: "1.0"
  clawdbot:
    emoji: 🧠
    requires:
      env:
        - MATON_API_KEY
---

# LinkedIn

Access the LinkedIn API with managed OAuth authentication. Share posts, manage advertising campaigns, retrieve profile and organization information, upload media, and access the Ad Library.

## Quick Start

```bash
# Get current user profile
python <<'EOF'
import urllib.request, os, json
req = urllib.request.Request('https://gateway.maton.ai/linkedin/v2/me')
req.add_header('Authorization', f'Bearer {os.environ["MATON_API_KEY"]}')
req.add_header('X-Restli-Protocol-Version', '2.0.0')
print(json.dumps(json.load(urllib.request.urlopen(req)), indent=2))
EOF
```

## Base URL

```
https://gateway.maton.ai/linkedin/v2/{resource}
```

The gateway proxies requests to `api.linkedin.com` and automatically injects your OAuth token.

## Authentication

All requests require the Maton API key in the Authorization header:

```
Authorization: Bearer $MATON_API_KEY
```

**Environment Variable:** Set your API key as `MATON_API_KEY`:

```bash
export MATON_API_KEY="YOUR_API_KEY"
```

### Getting Your API Key

1. Sign in or create an account at [maton.ai](https://maton.ai)
2. Go to [maton.ai/settings](https://maton.ai/settings)
3. Copy your API key

### Required Headers

LinkedIn API v2 requires the REST protocol version header:

```
X-Restli-Protocol-Version: 2.0.0
```

## Connection Management

Manage your LinkedIn OAuth connections at `https://ctrl.maton.ai`.

### List Connections

```bash
python <<'EOF'
import urllib.request, os, json
req = urllib.request.Request('https://ctrl.maton.ai/connections?app=linkedin&status=ACTIVE')
req.add_header('Authorization', f'Bearer {os.environ["MATON_API_KEY"]}')
print(json.dumps(json.load(urllib.request.urlopen(req)), indent=2))
EOF
```

### Create Connection

```bash
python <<'EOF'
import urllib.request, os, json
data = json.dumps({'app': 'linkedin'}).encode()
req = urllib.request.Request('https://ctrl.maton.ai/connections', data=data, method='POST')
req.add_header('Authorization', f'Bearer {os.environ["MATON_API_KEY"]}')
req.add_header('Content-Type', 'application/json')
print(json.dumps(json.load(urllib.request.urlopen(req)), indent=2))
EOF
```

### Get Connection

```bash
python <<'EOF'
import urllib.request, os, json
req = urllib.request.Request('https://ctrl.maton.ai/connections/{connection_id}')
req.add_header('Authorization', f'Bearer {os.environ["MATON_API_KEY"]}')
print(json.dumps(json.load(urllib.request.urlopen(req)), indent=2))
EOF
```

**Response:**

```json
{
  "connection": {
    "connection_id": "ba10eb9e-b590-4e95-8c2e-3901ff94642a",
    "status": "ACTIVE",
    "creation_time": "2026-02-07T08:00:24.372659Z",
    "last_updated_time": "2026-02-07T08:05:16.609085Z",
    "url": "https://connect.maton.ai/?session_token=...",
    "app": "linkedin",
    "metadata": {}
  }
}
```

Open the returned `url` in a browser to complete OAuth authorization.

### Delete Connection

```bash
python <<'EOF'
import urllib.request, os, json
req = urllib.request.Request('https://ctrl.maton.ai/connections/{connection_id}', method='DELETE')
req.add_header('Authorization', f'Bearer {os.environ["MATON_API_KEY"]}')
print(json.dumps(json.load(urllib.request.urlopen(req)), indent=2))
EOF
```

### Specifying Connection

If you have multiple LinkedIn connections, specify which one to use with the `Maton-Connection` header:

```bash
python <<'EOF'
import urllib.request, os, json
req = urllib.request.Request('https://gateway.maton.ai/linkedin/v2/userinfo')
req.add_header('Authorization', f'Bearer {os.environ["MATON_API_KEY"]}')
req.add_header('Maton-Connection', 'ba10eb9e-b590-4e95-8c2e-3901ff94642a')
print(json.dumps(json.load(urllib.request.urlopen(req)), indent=2))
EOF
```

If omitted, the gateway uses the default (oldest) active connection.

## API Reference

### Profile

#### Get User Info (OpenID Connect)

```bash
GET /linkedin/v2/userinfo
```

Returns basic profile information including name, email, and profile picture.

**Response:**

```json
{
  "sub": "782bbtaQ",
  "name": "John Doe",
  "given_name": "John",
  "family_name": "Doe",
  "picture": "https://media.licdn.com/dms/image/...",
  "email": "john@example.com",
  "email_verified": true,
  "locale": "en-US"
}
```

#### Get Current User Profile

```bash
GET /linkedin/v2/me
```

**With Field Projection:**

```bash
GET /linkedin/v2/me?projection=(id,firstName,lastName,profilePicture)
```

**Response:**

```json
{
  "firstName": {
    "localized": { "en_US": "John" },
    "preferredLocale": { "country": "US", "language": "en" }
  },
  "localizedFirstName": "John",
  "lastName": {
    "localized": { "en_US": "Doe" },
    "preferredLocale": { "country": "US", "language": "en" }
  },
  "localizedLastName": "Doe",
  "id": "yrZCpj2Z12",
  "profilePicture": {
    "displayImage": "urn:li:digitalmediaAsset:C4D00AAAAbBCDEFGhiJ"
  }
}
```

### Sharing Posts (UGC Posts)

#### Create a Text Post

```bash
POST /linkedin/v2/ugcPosts
Content-Type: application/json
X-Restli-Protocol-Version: 2.0.0

{
  "author": "urn:li:person:{personId}",
  "lifecycleState": "PUBLISHED",
  "specificContent": {
    "com.linkedin.ugc.ShareContent": {
      "shareCommentary": {
        "text": "Hello LinkedIn! This is my first API post."
      },
      "shareMediaCategory": "NONE"
    }
  },
  "visibility": {
    "com.linkedin.ugc.MemberNetworkVisibility": "PUBLIC"
  }
}
```

**Response:** `201 Created` with `X-RestLi-Id` header containing the post URN.

#### Create an Article/URL Share

```bash
POST /linkedin/v2/ugcPosts
Content-Type: application/json
X-Restli-Protocol-Version: 2.0.0

{
  "author": "urn:li:person:{personId}",
  "lifecycleState": "PUBLISHED",
  "specificContent": {
    "com.linkedin.ugc.ShareContent": {
      "shareCommentary": {
        "text": "Check out this great article!"
      },
      "shareMediaCategory": "ARTICLE",
      "media": [
        {
          "status": "READY",
          "originalUrl": "https://example.com/article",
          "title": {
            "text": "Article Title"
          },
          "description": {
            "text": "Article description here"
          }
        }
      ]
    }
  },
  "visibility": {
    "com.linkedin.ugc.MemberNetworkVisibility": "PUBLIC"
  }
}
```

#### Create an Image Post

First, register the image upload, then upload the image, then create the post.

**Step 1: Register Image Upload**

```bash
POST /linkedin/v2/assets?action=registerUpload
Content-Type: application/json
X-Restli-Protocol-Version: 2.0.0

{
  "registerUploadRequest": {
    "recipes": ["urn:li:digitalmediaRecipe:feedshare-image"],
    "owner": "urn:li:person:{personId}",
    "serviceRelationships": [
      {
        "relationshipType": "OWNER",
        "identifier": "urn:li:userGeneratedContent"
      }
    ]
  }
}
```

**Response:**

```json
{
  "value": {
    "uploadMechanism": {
      "com.linkedin.digitalmedia.uploading.MediaUploadHttpRequest": {
        "uploadUrl": "https://api.linkedin.com/mediaUpload/..."
      }
    },
    "asset": "urn:li:digitalmediaAsset:C5522AQGTYER3k3ByHQ"
  }
}
```

**Step 2: Upload Image Binary**

```bash
PUT {uploadUrl from step 1}
Content-Type: image/png

{binary image data}
```

**Step 3: Create Image Post**

```bash
POST /linkedin/v2/ugcPosts
Content-Type: application/json
X-Restli-Protocol-Version: 2.0.0

{
  "author": "urn:li:person:{personId}",
  "lifecycleState": "PUBLISHED",
  "specificContent": {
    "com.linkedin.ugc.ShareContent": {
      "shareCommentary": {
        "text": "Check out this image!"
      },
      "shareMediaCategory": "IMAGE",
      "media": [
        {
          "status": "READY",
          "media": "urn:li:digitalmediaAsset:C5522AQGTYER3k3ByHQ",
          "title": {
            "text": "Image Title"
          }
        }
      ]
    }
  },
  "visibility": {
    "com.linkedin.ugc.MemberNetworkVisibility": "PUBLIC"
  }
}
```

### Visibility Options

| Value         | Description                             |
| ------------- | --------------------------------------- |
| `PUBLIC`      | Viewable by anyone on LinkedIn          |
| `CONNECTIONS` | Viewable by 1st-degree connections only |

### Share Media Categories

| Value     | Description       |
| --------- | ----------------- |
| `NONE`    | Text-only post    |
| `ARTICLE` | URL/article share |
| `IMAGE`   | Image post        |
| `VIDEO`   | Video post        |

### Ad Library (Public Data)

The Ad Library API provides access to public advertising data on LinkedIn. These endpoints don't require user OAuth - they use the REST API with version headers.

#### Required Headers for Ad Library

```
X-Restli-Protocol-Version: 2.0.0
LinkedIn-Version: 202502
```

#### Search Ads

```bash
GET /linkedin/rest/adLibrary?q=criteria&keyword={keyword}
```

Query parameters:

- `keyword` (string): Search ad content (multiple keywords use AND logic)
- `advertiser` (string): Search by advertiser name
- `countries` (array): Filter by ISO 3166-1 alpha-2 country codes
- `dateRange` (object): Filter by served dates
- `start` (integer): Pagination offset
- `count` (integer): Results per page (max 25)

**Example - Search ads by keyword:**

```bash
GET /linkedin/rest/adLibrary?q=criteria&keyword=linkedin
```

**Example - Search ads by advertiser:**

```bash
GET /linkedin/rest/adLibrary?q=criteria&advertiser=microsoft
```

**Response:**

```json
{
  "paging": {
    "start": 0,
    "count": 10,
    "total": 11619543,
    "links": [...]
  },
  "elements": [
    {
      "adUrl": "https://www.linkedin.com/ad-library/detail/...",
      "details": {
        "advertiser": {...},
        "adType": "TEXT_AD",
        "targeting": {...},
        "statistics": {
          "firstImpressionDate": 1704067200000,
          "latestImpressionDate": 1706745600000,
          "impressionsFrom": 1000,
          "impressionsTo": 5000
        }
      },
      "isRestricted": false
    }
  ]
}
```

#### Search Job Postings

```bash
GET /linkedin/rest/jobLibrary?q=criteria&keyword={keyword}
```

**Note:** Job Library requires version `202506`.

Query parameters:

- `keyword` (string): Search job content
- `organization` (string): Filter by company name
- `countries` (array): Filter by country codes
- `dateRange` (object): Filter by posting dates
- `start` (integer): Pagination offset
- `count` (integer): Results per page (max 24)

**Example:**

```bash
GET /linkedin/rest/jobLibrary?q=criteria&keyword=software&organization=google
```

**Response includes:**

- `jobPostingUrl`: Link to job listing
- `jobDetails`: Title, location, description, salary, benefits
- `statistics`: Impression data

### Marketing API (Advertising)

The Marketing API provides access to LinkedIn's advertising platform. These endpoints use the versioned REST API.

#### Required Headers for Marketing API

```
X-Restli-Protocol-Version: 2.0.0
LinkedIn-Version: 202502
```

#### List Ad Accounts

```bash
GET /linkedin/rest/adAccounts?q=search
```

Returns all ad accounts accessible by the authenticated user.

**Response:**

```json
{
  "paging": {
    "start": 0,
    "count": 10,
    "links": []
  },
  "elements": [
    {
      "id": 123456789,
      "name": "My Ad Account",
      "status": "ACTIVE",
      "type": "BUSINESS",
      "currency": "USD",
      "reference": "urn:li:organization:12345"
    }
  ]
}
```

#### Get Ad Account

```bash
GET /linkedin/rest/adAccounts/{adAccountId}
```

#### Create Ad Account

```bash
POST /linkedin/rest/adAccounts
Content-Type: application/json

{
  "name": "New Ad Account",
  "currency": "USD",
  "reference": "urn:li:organization:{orgId}",
  "type": "BUSINESS"
}
```

#### Update Ad Account

```bash
POST /linkedin/rest/adAccounts/{adAccountId}
Content-Type: application/json
X-RestLi-Method: PARTIAL_UPDATE

{
  "patch": {
    "$set": {
      "name": "Updated Account Name"
    }
  }
}
```

#### List Campaign Groups

Campaign groups are nested under ad accounts:

```bash
GET /linkedin/rest/adAccounts/{adAccountId}/adCampaignGroups
```

#### Create Campaign Group

```bash
POST /linkedin/rest/adAccounts/{adAccountId}/adCampaignGroups
Content-Type: application/json

{
  "name": "Q1 2026 Campaigns",
  "status": "DRAFT",
  "runSchedule": {
    "start": 1704067200000,
    "end": 1711929600000
  },
  "totalBudget": {
    "amount": "10000",
    "currencyCode": "USD"
  }
}
```

#### Get Campaign Group

```bash
GET /linkedin/rest/adAccounts/{adAccountId}/adCampaignGroups/{campaignGroupId}
```

#### Update Campaign Group

```bash
POST /linkedin/rest/adAccounts/{adAccountId}/adCampaignGroups/{campaignGroupId}
Content-Type: application/json
X-RestLi-Method: PARTIAL_UPDATE

{
  "patch": {
    "$set": {
      "status": "ACTIVE"
    }
  }
}
```

#### Delete Campaign Group

```bash
DELETE /linkedin/rest/adAccounts/{adAccountId}/adCampaignGroups/{campaignGroupId}
```

#### List Campaigns

Campaigns are also nested under ad accounts:

```bash
GET /linkedin/rest/adAccounts/{adAccountId}/adCampaigns
```

#### Create Campaign

```bash
POST /linkedin/rest/adAccounts/{adAccountId}/adCampaigns
Content-Type: application/json

{
  "campaignGroup": "urn:li:sponsoredCampaignGroup:123456",
  "name": "Brand Awareness Campaign",
  "status": "DRAFT",
  "type": "SPONSORED_UPDATES",
  "objectiveType": "BRAND_AWARENESS",
  "dailyBudget": {
    "amount": "100",
    "currencyCode": "USD"
  },
  "costType": "CPM",
  "unitCost": {
    "amount": "5",
    "currencyCode": "USD"
  },
  "locale": {
    "country": "US",
    "language": "en"
  }
}
```

#### Get Campaign

```bash
GET /linkedin/rest/adAccounts/{adAccountId}/adCampaigns/{campaignId}
```

#### Update Campaign

```bash
POST /linkedin/rest/adAccounts/{adAccountId}/adCampaigns/{campaignId}
Content-Type: application/json
X-RestLi-Method: PARTIAL_UPDATE

{
  "patch": {
    "$set": {
      "status": "ACTIVE"
    }
  }
}
```

#### Delete Campaign

```bash
DELETE /linkedin/rest/adAccounts/{adAccountId}/adCampaigns/{campaignId}
```

### Campaign Status Values

| Status      | Description               |
| ----------- | ------------------------- |
| `DRAFT`     | Campaign is in draft mode |
| `ACTIVE`    | Campaign is running       |
| `PAUSED`    | Campaign is paused        |
| `ARCHIVED`  | Campaign is archived      |
| `COMPLETED` | Campaign has ended        |
| `CANCELED`  | Campaign was canceled     |

### Campaign Objective Types

| Objective             | Description                      |
| --------------------- | -------------------------------- |
| `BRAND_AWARENESS`     | Increase brand visibility        |
| `WEBSITE_VISITS`      | Drive traffic to website         |
| `ENGAGEMENT`          | Increase post engagement         |
| `VIDEO_VIEWS`         | Maximize video views             |
| `LEAD_GENERATION`     | Collect leads via Lead Gen Forms |
| `WEBSITE_CONVERSIONS` | Drive website conversions        |
| `JOB_APPLICANTS`      | Attract job applications         |

### Organizations

#### List Organization ACLs

Get organizations the authenticated user has access to:

```bash
GET /linkedin/v2/organizationAcls?q=roleAssignee
```

**Response:**

```json
{
  "paging": {
    "start": 0,
    "count": 10,
    "total": 2
  },
  "elements": [
    {
      "role": "ADMINISTRATOR",
      "organization": "urn:li:organization:12345",
      "state": "APPROVED"
    }
  ]
}
```

#### Get Organization

```bash
GET /linkedin/v2/organizations/{organizationId}
```

#### Lookup Organization by Vanity Name

```bash
GET /linkedin/rest/organizations?q=vanityName&vanityName={vanityName}
```

**Example:**

```bash
GET /linkedin/rest/organizations?q=vanityName&vanityName=microsoft
```

**Response:**

```json
{
  "elements": [
    {
      "vanityName": "microsoft",
      "localizedName": "Microsoft",
      "website": {
        "localized": { "en_US": "https://news.microsoft.com/" }
      }
    }
  ]
}
```

#### Get Organization Share Statistics

```bash
GET /linkedin/rest/organizationalEntityShareStatistics?q=organizationalEntity&organizationalEntity={orgUrn}
```

**Example:**

```bash
GET /linkedin/rest/organizationalEntityShareStatistics?q=organizationalEntity&organizationalEntity=urn:li:organization:12345
```

#### Get Organization Posts

```bash
GET /linkedin/rest/posts?q=author&author={orgUrn}
```

**Example:**

```bash
GET /linkedin/rest/posts?q=author&author=urn:li:organization:12345
```

### Media Upload (REST API)

The REST API provides modern media upload endpoints. All require version header `LinkedIn-Version: 202502`.

#### Initialize Image Upload

```bash
POST /linkedin/rest/images?action=initializeUpload
Content-Type: application/json
LinkedIn-Version: 202502

{
  "initializeUploadRequest": {
    "owner": "urn:li:person:{personId}"
  }
}
```

**Response:**

```json
{
  "value": {
    "uploadUrlExpiresAt": 1770541529250,
    "uploadUrl": "https://www.linkedin.com/dms-uploads/...",
    "image": "urn:li:image:D4D10AQH4GJAjaFCkHQ"
  }
}
```

Use the `uploadUrl` to PUT your image binary, then use the `image` URN in your post.

#### Initialize Video Upload

```bash
POST /linkedin/rest/videos?action=initializeUpload
Content-Type: application/json
LinkedIn-Version: 202502

{
  "initializeUploadRequest": {
    "owner": "urn:li:person:{personId}",
    "fileSizeBytes": 10000000,
    "uploadCaptions": false,
    "uploadThumbnail": false
  }
}
```

**Response:**

```json
{
  "value": {
    "uploadUrlsExpireAt": 1770541530110,
    "video": "urn:li:video:D4D10AQE_p-P_odQhXQ",
    "uploadInstructions": [{ "uploadUrl": "https://www.linkedin.com/dms-uploads/..." }]
  }
}
```

#### Initialize Document Upload

```bash
POST /linkedin/rest/documents?action=initializeUpload
Content-Type: application/json
LinkedIn-Version: 202502

{
  "initializeUploadRequest": {
    "owner": "urn:li:person:{personId}"
  }
}
```

**Response:**

```json
{
  "value": {
    "uploadUrlExpiresAt": 1770541530896,
    "uploadUrl": "https://www.linkedin.com/dms-uploads/...",
    "document": "urn:li:document:D4D10AQHr-e30QZCAjQ"
  }
}
```

### Ad Targeting

#### Get Available Targeting Facets

```bash
GET /linkedin/rest/adTargetingFacets
```

Returns all available targeting facets for ad campaigns (31 facets including employers, degrees, skills, locations, industries, etc.).

**Response:**

```json
{
  "elements": [
    {
      "facetName": "skills",
      "adTargetingFacetUrn": "urn:li:adTargetingFacet:skills",
      "entityTypes": ["SKILL"],
      "availableEntityFinders": ["AD_TARGETING_FACET", "TYPEAHEAD"]
    },
    {
      "facetName": "industries",
      "adTargetingFacetUrn": "urn:li:adTargetingFacet:industries"
    }
  ]
}
```

Available targeting facets include:

- `skills` - Member skills
- `industries` - Industry categories
- `titles` - Job titles
- `seniorities` - Seniority levels
- `degrees` - Educational degrees
- `schools` - Educational institutions
- `employers` / `employersPast` - Current/past employers
- `locations` / `geoLocations` - Geographic targeting
- `companySize` - Company size ranges
- `genders` - Gender targeting
- `ageRanges` - Age range targeting

## Getting Your Person ID

To create posts, you need your LinkedIn person ID. Get it from the `/v2/me` endpoint:

```bash
python <<'EOF'
import urllib.request, os, json
req = urllib.request.Request('https://gateway.maton.ai/linkedin/v2/me')
req.add_header('Authorization', f'Bearer {os.environ["MATON_API_KEY"]}')
result = json.load(urllib.request.urlopen(req))
print(f"Your person URN: urn:li:person:{result['id']}")
EOF
```

## Code Examples

### JavaScript - Create Text Post

```javascript
const personId = "YOUR_PERSON_ID";

const response = await fetch("https://gateway.maton.ai/linkedin/v2/ugcPosts", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${process.env.MATON_API_KEY}`,
    "Content-Type": "application/json",
    "X-Restli-Protocol-Version": "2.0.0",
  },
  body: JSON.stringify({
    author: `urn:li:person:${personId}`,
    lifecycleState: "PUBLISHED",
    specificContent: {
      "com.linkedin.ugc.ShareContent": {
        shareCommentary: { text: "Hello from the API!" },
        shareMediaCategory: "NONE",
      },
    },
    visibility: {
      "com.linkedin.ugc.MemberNetworkVisibility": "PUBLIC",
    },
  }),
});
```

### Python - Create Text Post

```python
import os
import requests

person_id = 'YOUR_PERSON_ID'

response = requests.post(
    'https://gateway.maton.ai/linkedin/v2/ugcPosts',
    headers={
        'Authorization': f'Bearer {os.environ["MATON_API_KEY"]}',
        'Content-Type': 'application/json',
        'X-Restli-Protocol-Version': '2.0.0'
    },
    json={
        'author': f'urn:li:person:{person_id}',
        'lifecycleState': 'PUBLISHED',
        'specificContent': {
            'com.linkedin.ugc.ShareContent': {
                'shareCommentary': {'text': 'Hello from the API!'},
                'shareMediaCategory': 'NONE'
            }
        },
        'visibility': {
            'com.linkedin.ugc.MemberNetworkVisibility': 'PUBLIC'
        }
    }
)
```

## Rate Limits

| Throttle Type | Daily Limit (UTC)    |
| ------------- | -------------------- |
| Member        | 150 requests/day     |
| Application   | 100,000 requests/day |

## Notes

- Person IDs are unique per application and not transferable across apps
- The `author` field must use URN format: `urn:li:person:{personId}`
- All posts require `lifecycleState: "PUBLISHED"`
- Image/video uploads are a 3-step process: register, upload binary, create post
- Include `X-Restli-Protocol-Version: 2.0.0` header for v2 API calls
- Profile picture URLs may expire; re-fetch if needed
- IMPORTANT: When using curl commands, use `curl -g` when URLs contain brackets to disable glob parsing
- IMPORTANT: When piping curl output to `jq` or other commands, environment variables like `$MATON_API_KEY` may not expand correctly in some shell environments

## Error Handling

| Status  | Meaning                                        |
| ------- | ---------------------------------------------- |
| 400     | Missing LinkedIn connection or invalid request |
| 401     | Invalid or missing Maton API key               |
| 403     | Insufficient permissions (check OAuth scopes)  |
| 404     | Resource not found                             |
| 422     | Invalid request body or URN format             |
| 429     | Rate limited                                   |
| 4xx/5xx | Passthrough error from LinkedIn API            |

### Error Response Format

```json
{
  "status": 403,
  "serviceErrorCode": 100,
  "code": "ACCESS_DENIED",
  "message": "Not enough permissions to access resource"
}
```

### Troubleshooting: API Key Issues

1. Check that the `MATON_API_KEY` environment variable is set:

```bash
echo $MATON_API_KEY
```

2. Verify the API key is valid by listing connections:

```bash
python <<'EOF'
import urllib.request, os, json
req = urllib.request.Request('https://ctrl.maton.ai/connections')
req.add_header('Authorization', f'Bearer {os.environ["MATON_API_KEY"]}')
print(json.dumps(json.load(urllib.request.urlopen(req)), indent=2))
EOF
```

### Troubleshooting: Invalid App Name

1. Ensure your URL path starts with `linkedin`. For example:

- Correct: `https://gateway.maton.ai/linkedin/v2/me`
- Incorrect: `https://gateway.maton.ai/v2/me`

## OAuth Scopes

| Scope             | Description                      |
| ----------------- | -------------------------------- |
| `openid`          | OpenID Connect authentication    |
| `profile`         | Read basic profile               |
| `email`           | Read email address               |
| `w_member_social` | Create, modify, and delete posts |

## Resources

- [LinkedIn API Overview](https://learn.microsoft.com/en-us/linkedin/)
- [Share on LinkedIn Guide](https://learn.microsoft.com/en-us/linkedin/consumer/integrations/self-serve/share-on-linkedin)
- [Profile API](https://learn.microsoft.com/en-us/linkedin/shared/integrations/people/profile-api)
- [Sign In with LinkedIn](https://learn.microsoft.com/en-us/linkedin/consumer/integrations/self-serve/sign-in-with-linkedin-v2)
- [Authentication Guide](https://learn.microsoft.com/en-us/linkedin/shared/authentication/authentication)
- [Marketing API](https://learn.microsoft.com/en-us/linkedin/marketing/)
- [Ad Accounts](https://learn.microsoft.com/en-us/linkedin/marketing/integrations/ads/account-structure/create-and-manage-accounts)
- [Campaign Management](https://learn.microsoft.com/en-us/linkedin/marketing/integrations/ads/account-structure/create-and-manage-campaigns)
- [Ad Library API](https://www.linkedin.com/ad-library/api/)
- [Maton Community](https://discord.com/invite/dBfFAcefs2)
- [Maton Support](mailto:support@maton.ai)
