# Coda Routing Reference

**App name:** `coda`
**Base URL proxied:** `coda.io/apis/v1`

## API Path Pattern

```
/coda/apis/v1/{resource}
```

## Common Endpoints

### Account

#### Get Current User

```bash
GET /coda/apis/v1/whoami
```

### Docs

#### List Docs

```bash
GET /coda/apis/v1/docs
```

#### Create Doc

```bash
POST /coda/apis/v1/docs
```

#### Get Doc

```bash
GET /coda/apis/v1/docs/{docId}
```

#### Delete Doc

```bash
DELETE /coda/apis/v1/docs/{docId}
```

### Pages

#### List Pages

```bash
GET /coda/apis/v1/docs/{docId}/pages
```

#### Create Page

```bash
POST /coda/apis/v1/docs/{docId}/pages
```

#### Get Page

```bash
GET /coda/apis/v1/docs/{docId}/pages/{pageIdOrName}
```

#### Update Page

```bash
PUT /coda/apis/v1/docs/{docId}/pages/{pageIdOrName}
```

#### Delete Page

```bash
DELETE /coda/apis/v1/docs/{docId}/pages/{pageIdOrName}
```

### Tables

#### List Tables

```bash
GET /coda/apis/v1/docs/{docId}/tables
```

#### Get Table

```bash
GET /coda/apis/v1/docs/{docId}/tables/{tableIdOrName}
```

### Columns

#### List Columns

```bash
GET /coda/apis/v1/docs/{docId}/tables/{tableIdOrName}/columns
```

#### Get Column

```bash
GET /coda/apis/v1/docs/{docId}/tables/{tableIdOrName}/columns/{columnIdOrName}
```

### Rows

#### List Rows

```bash
GET /coda/apis/v1/docs/{docId}/tables/{tableIdOrName}/rows
```

#### Get Row

```bash
GET /coda/apis/v1/docs/{docId}/tables/{tableIdOrName}/rows/{rowIdOrName}
```

#### Insert/Upsert Rows

```bash
POST /coda/apis/v1/docs/{docId}/tables/{tableIdOrName}/rows
```

#### Update Row

```bash
PUT /coda/apis/v1/docs/{docId}/tables/{tableIdOrName}/rows/{rowIdOrName}
```

#### Delete Row

```bash
DELETE /coda/apis/v1/docs/{docId}/tables/{tableIdOrName}/rows/{rowIdOrName}
```

### Formulas

#### List Formulas

```bash
GET /coda/apis/v1/docs/{docId}/formulas
```

#### Get Formula

```bash
GET /coda/apis/v1/docs/{docId}/formulas/{formulaIdOrName}
```

### Controls

#### List Controls

```bash
GET /coda/apis/v1/docs/{docId}/controls
```

#### Get Control

```bash
GET /coda/apis/v1/docs/{docId}/controls/{controlIdOrName}
```

### Permissions

#### Get Sharing Metadata

```bash
GET /coda/apis/v1/docs/{docId}/acl/metadata
```

#### List Permissions

```bash
GET /coda/apis/v1/docs/{docId}/acl/permissions
```

#### Add Permission

```bash
POST /coda/apis/v1/docs/{docId}/acl/permissions
```

#### Delete Permission

```bash
DELETE /coda/apis/v1/docs/{docId}/acl/permissions/{permissionId}
```

### Categories

#### List Categories

```bash
GET /coda/apis/v1/categories
```

### Utilities

#### Resolve Browser Link

```bash
GET /coda/apis/v1/resolveBrowserLink?url={encodedUrl}
```

#### Get Mutation Status

```bash
GET /coda/apis/v1/mutationStatus/{requestId}
```

### Analytics

#### List Doc Analytics

```bash
GET /coda/apis/v1/analytics/docs
```

#### List Pack Analytics

```bash
GET /coda/apis/v1/analytics/packs
```

#### Get Analytics Update Time

```bash
GET /coda/apis/v1/analytics/updated
```

## Query Parameters

Common parameters across endpoints:

- `limit` - Page size (max: 200)
- `pageToken` - Cursor for pagination
- `query` - Search filter
- `useColumnNames` - Use column names vs IDs (rows)
- `valueFormat` - simple, simpleWithArrays, rich (rows)

## Notes

- Mutations (create/update/delete) return HTTP 202 with requestId
- Use `/mutationStatus/{requestId}` to check completion
- Newly created docs need a moment before child resources are accessible
- Table/column names can be used instead of IDs
- Row operations require base tables, not views
- Page-level analytics require Enterprise plan

## Resources

- [Coda API Documentation](https://coda.io/developers/apis/v1)
