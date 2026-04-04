# Salesforce Routing Reference

**App name:** `salesforce`
**Base URL proxied:** `{instance}.salesforce.com`

The router automatically determines the instance URL from your OAuth credentials (`instance_url` from the token response).

## API Path Pattern

```
/salesforce/services/data/v59.0/{endpoint}
```

## Common Endpoints

### SOQL Query

```bash
GET /salesforce/services/data/v59.0/query?q=SELECT+Id,Name+FROM+Contact+LIMIT+10
```

Complex query:

```bash
GET /salesforce/services/data/v59.0/query?q=SELECT+Id,Name,Email+FROM+Contact+WHERE+Email+LIKE+'%example.com'+ORDER+BY+CreatedDate+DESC
```

### Get Object

```bash
GET /salesforce/services/data/v59.0/sobjects/{objectType}/{recordId}
```

Example:

```bash
GET /salesforce/services/data/v59.0/sobjects/Contact/003XXXXXXXXXXXXXXX
```

### Create Object

```bash
POST /salesforce/services/data/v59.0/sobjects/{objectType}
Content-Type: application/json

{
  "FirstName": "John",
  "LastName": "Doe",
  "Email": "john@example.com"
}
```

### Update Object

```bash
PATCH /salesforce/services/data/v59.0/sobjects/{objectType}/{recordId}
Content-Type: application/json

{
  "Phone": "+1234567890"
}
```

### Delete Object

```bash
DELETE /salesforce/services/data/v59.0/sobjects/{objectType}/{recordId}
```

### Describe Object (get schema)

```bash
GET /salesforce/services/data/v59.0/sobjects/{objectType}/describe
```

### List Objects

```bash
GET /salesforce/services/data/v59.0/sobjects
```

### Search (SOSL)

```bash
GET /salesforce/services/data/v59.0/search?q=FIND+{searchTerm}+IN+ALL+FIELDS+RETURNING+Contact(Id,Name)
```

### Composite Request (batch multiple operations)

```bash
POST /salesforce/services/data/v59.0/composite
Content-Type: application/json

{
  "compositeRequest": [
    {
      "method": "GET",
      "url": "/services/data/v59.0/sobjects/Contact/003XXXXXXX",
      "referenceId": "contact1"
    },
    {
      "method": "GET",
      "url": "/services/data/v59.0/sobjects/Account/001XXXXXXX",
      "referenceId": "account1"
    }
  ]
}
```

### Composite Batch Request

```bash
POST /salesforce/services/data/v59.0/composite/batch
Content-Type: application/json

{
  "batchRequests": [
    {"method": "GET", "url": "v59.0/sobjects/Contact/003XXXXXXX"},
    {"method": "GET", "url": "v59.0/sobjects/Account/001XXXXXXX"}
  ]
}
```

### sObject Collections Create (batch create)

```bash
POST /salesforce/services/data/v59.0/composite/sobjects
Content-Type: application/json

{
  "allOrNone": true,
  "records": [
    {"attributes": {"type": "Contact"}, "FirstName": "John", "LastName": "Doe"},
    {"attributes": {"type": "Contact"}, "FirstName": "Jane", "LastName": "Smith"}
  ]
}
```

### sObject Collections Delete (batch delete)

```bash
DELETE /salesforce/services/data/v59.0/composite/sobjects?ids=003XXXXX,003YYYYY&allOrNone=true
```

### Get Updated Records

```bash
GET /salesforce/services/data/v59.0/sobjects/{objectType}/updated/?start=2026-01-30T00:00:00Z&end=2026-02-01T00:00:00Z
```

### Get Deleted Records

```bash
GET /salesforce/services/data/v59.0/sobjects/{objectType}/deleted/?start=2026-01-30T00:00:00Z&end=2026-02-01T00:00:00Z
```

### Get API Limits

```bash
GET /salesforce/services/data/v59.0/limits
```

### List API Versions

```bash
GET /salesforce/services/data/
```

## Common Objects

- `Account` - Companies/Organizations
- `Contact` - People associated with accounts
- `Lead` - Potential customers
- `Opportunity` - Sales deals
- `Case` - Support cases
- `Task` - To-do items
- `Event` - Calendar events

## Notes

- Use URL encoding for SOQL queries (spaces become `+`)
- Record IDs are 15 or 18 character alphanumeric strings
- API version (v59.0) can be adjusted; latest is v65.0
- Update and Delete operations return HTTP 204 (no content) on success
- Dates for updated/deleted queries use ISO 8601 format: `YYYY-MM-DDTHH:MM:SSZ`
- Use `allOrNone: true` in batch operations for atomic transactions

## Resources

- [REST API Developer Guide](https://developer.salesforce.com/docs/atlas.en-us.api_rest.meta/api_rest/intro_rest.htm)
- [List sObjects](https://developer.salesforce.com/docs/atlas.en-us.api_rest.meta/api_rest/resources_describeGlobal.htm)
- [Describe sObject](https://developer.salesforce.com/docs/atlas.en-us.api_rest.meta/api_rest/resources_sobject_describe.htm)
- [Get Record](https://developer.salesforce.com/docs/atlas.en-us.api_rest.meta/api_rest/resources_sobject_retrieve_get.htm)
- [Get Record by External ID](https://developer.salesforce.com/docs/atlas.en-us.api_rest.meta/api_rest/resources_sobject_upsert_get.htm)
- [Create Record](https://developer.salesforce.com/docs/atlas.en-us.api_rest.meta/api_rest/dome_sobject_create.htm)
- [Update Record](https://developer.salesforce.com/docs/atlas.en-us.api_rest.meta/api_rest/dome_update_fields.htm)
- [Delete Record](https://developer.salesforce.com/docs/atlas.en-us.api_rest.meta/api_rest/dome_delete_record.htm)
- [Upsert Record](https://developer.salesforce.com/docs/atlas.en-us.api_rest.meta/api_rest/dome_upsert.htm)
- [Query Records (SOQL)](https://developer.salesforce.com/docs/atlas.en-us.api_rest.meta/api_rest/resources_query.htm)
- [Get Updated Records](https://developer.salesforce.com/docs/atlas.en-us.api_rest.meta/api_rest/resources_getupdated.htm)
- [Get Deleted Records](https://developer.salesforce.com/docs/atlas.en-us.api_rest.meta/api_rest/resources_getdeleted.htm)
- [Composite Request](https://developer.salesforce.com/docs/atlas.en-us.api_rest.meta/api_rest/resources_composite_composite_post.htm)
- [Composite Batch Request](https://developer.salesforce.com/docs/atlas.en-us.api_rest.meta/api_rest/requests_composite_batch.htm)
- [Composite Batch Response](https://developer.salesforce.com/docs/atlas.en-us.api_rest.meta/api_rest/responses_composite_batch.htm)
- [Composite Graph](https://developer.salesforce.com/docs/atlas.en-us.api_rest.meta/api_rest/resources_composite_graph.htm)
- [sObject Collections Create](https://developer.salesforce.com/docs/atlas.en-us.api_rest.meta/api_rest/resources_composite_sobjects_collections_create.htm)
- [sObject Collections Update](https://developer.salesforce.com/docs/atlas.en-us.api_rest.meta/api_rest/resources_composite_sobjects_collections_update.htm)
- [sObject Collections Delete](https://developer.salesforce.com/docs/atlas.en-us.api_rest.meta/api_rest/resources_composite_sobjects_collections_delete.htm)
- [SOQL Reference](https://developer.salesforce.com/docs/atlas.en-us.soql_sosl.meta/soql_sosl/sforce_api_calls_soql.htm)
- [SOSL Reference](https://developer.salesforce.com/docs/atlas.en-us.soql_sosl.meta/soql_sosl/sforce_api_calls_sosl.htm)
- [API Resources List](https://developer.salesforce.com/docs/atlas.en-us.api_rest.meta/api_rest/resources_list.htm)
