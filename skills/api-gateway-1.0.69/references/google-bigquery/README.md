# Google BigQuery Routing Reference

**App name:** `google-bigquery`
**Base URL proxied:** `bigquery.googleapis.com`

## API Path Pattern

```
/google-bigquery/bigquery/v2/{resource}
```

## Common Endpoints

### List Projects

```bash
GET /google-bigquery/bigquery/v2/projects
```

### List Datasets

```bash
GET /google-bigquery/bigquery/v2/projects/{projectId}/datasets
```

### Get Dataset

```bash
GET /google-bigquery/bigquery/v2/projects/{projectId}/datasets/{datasetId}
```

### Create Dataset

```bash
POST /google-bigquery/bigquery/v2/projects/{projectId}/datasets
Content-Type: application/json

{
  "datasetReference": {
    "datasetId": "my_dataset",
    "projectId": "{projectId}"
  },
  "location": "US"
}
```

### Delete Dataset

```bash
DELETE /google-bigquery/bigquery/v2/projects/{projectId}/datasets/{datasetId}
```

### List Tables

```bash
GET /google-bigquery/bigquery/v2/projects/{projectId}/datasets/{datasetId}/tables
```

### Get Table

```bash
GET /google-bigquery/bigquery/v2/projects/{projectId}/datasets/{datasetId}/tables/{tableId}
```

### Create Table

```bash
POST /google-bigquery/bigquery/v2/projects/{projectId}/datasets/{datasetId}/tables
Content-Type: application/json

{
  "tableReference": {
    "projectId": "{projectId}",
    "datasetId": "{datasetId}",
    "tableId": "my_table"
  },
  "schema": {
    "fields": [
      {"name": "id", "type": "INTEGER"},
      {"name": "name", "type": "STRING"}
    ]
  }
}
```

### Delete Table

```bash
DELETE /google-bigquery/bigquery/v2/projects/{projectId}/datasets/{datasetId}/tables/{tableId}
```

### List Table Data

```bash
GET /google-bigquery/bigquery/v2/projects/{projectId}/datasets/{datasetId}/tables/{tableId}/data
```

### Run Query (Synchronous)

```bash
POST /google-bigquery/bigquery/v2/projects/{projectId}/queries
Content-Type: application/json

{
  "query": "SELECT * FROM `dataset.table` LIMIT 10",
  "useLegacySql": false
}
```

### List Jobs

```bash
GET /google-bigquery/bigquery/v2/projects/{projectId}/jobs
```

### Get Job

```bash
GET /google-bigquery/bigquery/v2/projects/{projectId}/jobs/{jobId}?location=US
```

### Cancel Job

```bash
POST /google-bigquery/bigquery/v2/projects/{projectId}/jobs/{jobId}/cancel?location=US
```

## Query Examples

### Simple Query

```json
{
  "query": "SELECT 1 as test",
  "useLegacySql": false
}
```

### Query with Parameters

```json
{
  "query": "SELECT * FROM `dataset.table` WHERE id = @id",
  "useLegacySql": false,
  "queryParameters": [
    {
      "name": "id",
      "parameterType": { "type": "INT64" },
      "parameterValue": { "value": "123" }
    }
  ]
}
```

### Query to Destination Table

```json
{
  "query": "SELECT * FROM `source_dataset.source_table`",
  "useLegacySql": false,
  "destinationTable": {
    "projectId": "my-project",
    "datasetId": "dest_dataset",
    "tableId": "dest_table"
  },
  "writeDisposition": "WRITE_TRUNCATE"
}
```

## Common Schema Types

- `STRING` - Text data
- `INTEGER` - 64-bit signed integer
- `FLOAT` - 64-bit floating point
- `BOOLEAN` - True/false
- `TIMESTAMP` - Point in time
- `DATE` - Calendar date
- `RECORD` - Nested structure

## Notes

- Authentication is automatic - the router injects the OAuth token
- Project IDs are strings like `my-project-123`
- Dataset and table IDs: letters, numbers, underscores only
- Query results use `f` (fields) and `v` (value) structure
- Use `useLegacySql: false` for standard SQL
- Streaming inserts require BigQuery paid tier
- Jobs include location in their reference (US, EU, etc.)
- Use `maxResults` and `pageToken` for pagination

## Resources

- [BigQuery API Overview](https://cloud.google.com/bigquery/docs/reference/rest)
- [Datasets](https://cloud.google.com/bigquery/docs/reference/rest/v2/datasets)
- [Tables](https://cloud.google.com/bigquery/docs/reference/rest/v2/tables)
- [Jobs](https://cloud.google.com/bigquery/docs/reference/rest/v2/jobs)
- [Standard SQL Reference](https://cloud.google.com/bigquery/docs/reference/standard-sql/query-syntax)
