# Google Analytics Admin Routing Reference

**App name:** `google-analytics-admin`
**Base URL proxied:** `analyticsadmin.googleapis.com`

## API Path Pattern

```
/google-analytics-admin/v1beta/{endpoint}
```

## Common Endpoints

### List Accounts

```bash
GET /google-analytics-admin/v1beta/accounts
```

### Get Account

```bash
GET /google-analytics-admin/v1beta/accounts/{accountId}
```

### List Properties

```bash
GET /google-analytics-admin/v1beta/properties?filter=parent:accounts/{accountId}
```

### Get Property

```bash
GET /google-analytics-admin/v1beta/properties/{propertyId}
```

### Create Property

```bash
POST /google-analytics-admin/v1beta/properties
Content-Type: application/json

{
  "parent": "accounts/{accountId}",
  "displayName": "My New Property",
  "timeZone": "America/Los_Angeles",
  "currencyCode": "USD",
  "industryCategory": "TECHNOLOGY"
}
```

### Update Property

```bash
PATCH /google-analytics-admin/v1beta/properties/{propertyId}?updateMask=displayName
Content-Type: application/json

{
  "displayName": "Updated Property Name"
}
```

### List Data Streams

```bash
GET /google-analytics-admin/v1beta/properties/{propertyId}/dataStreams
```

### Get Data Stream

```bash
GET /google-analytics-admin/v1beta/properties/{propertyId}/dataStreams/{dataStreamId}
```

### Create Web Data Stream

```bash
POST /google-analytics-admin/v1beta/properties/{propertyId}/dataStreams
Content-Type: application/json

{
  "type": "WEB_DATA_STREAM",
  "displayName": "My Website",
  "webStreamData": {
    "defaultUri": "https://example.com"
  }
}
```

### List Custom Dimensions

```bash
GET /google-analytics-admin/v1beta/properties/{propertyId}/customDimensions
```

### Create Custom Dimension

```bash
POST /google-analytics-admin/v1beta/properties/{propertyId}/customDimensions
Content-Type: application/json

{
  "parameterName": "user_type",
  "displayName": "User Type",
  "scope": "USER",
  "description": "Type of user (free, premium, enterprise)"
}
```

### List Custom Metrics

```bash
GET /google-analytics-admin/v1beta/properties/{propertyId}/customMetrics
```

### Create Custom Metric

```bash
POST /google-analytics-admin/v1beta/properties/{propertyId}/customMetrics
Content-Type: application/json

{
  "parameterName": "points_earned",
  "displayName": "Points Earned",
  "scope": "EVENT",
  "measurementUnit": "STANDARD",
  "description": "Number of loyalty points earned"
}
```

### List Conversion Events

```bash
GET /google-analytics-admin/v1beta/properties/{propertyId}/conversionEvents
```

### Create Conversion Event

```bash
POST /google-analytics-admin/v1beta/properties/{propertyId}/conversionEvents
Content-Type: application/json

{
  "eventName": "purchase"
}
```

### Get Measurement Protocol Secret

```bash
GET /google-analytics-admin/v1beta/properties/{propertyId}/dataStreams/{dataStreamId}/measurementProtocolSecrets
```

### Create Measurement Protocol Secret

```bash
POST /google-analytics-admin/v1beta/properties/{propertyId}/dataStreams/{dataStreamId}/measurementProtocolSecrets
Content-Type: application/json

{
  "displayName": "Server-side tracking"
}
```

## Account Summaries

### List Account Summaries

```bash
GET /google-analytics-admin/v1beta/accountSummaries
```

Returns a lightweight summary of all accounts and properties the user has access to.

## Data Stream Types

- `WEB_DATA_STREAM` - Website tracking
- `ANDROID_APP_DATA_STREAM` - Android app
- `IOS_APP_DATA_STREAM` - iOS app

## Custom Dimension Scopes

- `EVENT` - Dimension applies to events
- `USER` - Dimension applies to users

## Custom Metric Scopes

- `EVENT` - Metric applies to events

## Measurement Units (Custom Metrics)

- `STANDARD` - Integer or decimal
- `CURRENCY` - Currency value
- `FEET`, `METERS` - Distance
- `MILES`, `KILOMETERS` - Distance
- `MILLISECONDS`, `SECONDS`, `MINUTES`, `HOURS` - Time

## Industry Categories

- `AUTOMOTIVE`, `BUSINESS_AND_INDUSTRIAL_MARKETS`, `FINANCE`, `HEALTHCARE`
- `TECHNOLOGY`, `TRAVEL`, `RETAIL`, `REAL_ESTATE`, `GAMES`
- `ARTS_AND_ENTERTAINMENT`, `BEAUTY_AND_FITNESS`, `BOOKS_AND_LITERATURE`
- `FOOD_AND_DRINK`, `HOBBIES_AND_LEISURE`, `HOME_AND_GARDEN`
- `INTERNET_AND_TELECOM`, `JOBS_AND_EDUCATION`, `LAW_AND_GOVERNMENT`
- `NEWS`, `ONLINE_COMMUNITIES`, `PEOPLE_AND_SOCIETY`, `PETS_AND_ANIMALS`
- `REFERENCE`, `SCIENCE`, `SHOPPING`, `SPORTS`

## Notes

- Authentication is automatic - the router injects the OAuth token
- Property IDs are numeric (e.g., `properties/521310447`)
- Account IDs are numeric (e.g., `accounts/123456789`)
- GA4 properties only (Universal Analytics not supported)
- Use `accountSummaries` endpoint to quickly list all accessible properties
- The `filter` parameter on list properties uses format: `parent:accounts/{accountId}`
- Use `updateMask` query parameter to specify which fields to update in PATCH requests
- This API is for property/account management - use the Data API for running reports

## Resources

- [API Overview](https://developers.google.com/analytics/devguides/config/admin/v1)
- [List Accounts](https://developers.google.com/analytics/devguides/config/admin/v1/rest/v1beta/accounts/list)
- [List Properties](https://developers.google.com/analytics/devguides/config/admin/v1/rest/v1beta/properties/list)
- [Create Property](https://developers.google.com/analytics/devguides/config/admin/v1/rest/v1beta/properties/create)
- [Data Streams](https://developers.google.com/analytics/devguides/config/admin/v1/rest/v1beta/properties.dataStreams)
- [Custom Dimensions](https://developers.google.com/analytics/devguides/config/admin/v1/rest/v1beta/properties.customDimensions)
- [Custom Metrics](https://developers.google.com/analytics/devguides/config/admin/v1/rest/v1beta/properties.customMetrics)
- [Conversion Events](https://developers.google.com/analytics/devguides/config/admin/v1/rest/v1beta/properties.conversionEvents)
