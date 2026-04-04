# Microsoft Excel Routing Reference

**App name:** `microsoft-excel`
**Base URL proxied:** `graph.microsoft.com`

## API Path Pattern

```
/microsoft-excel/v1.0/me/drive/items/{file-id}/workbook/{resource}
/microsoft-excel/v1.0/me/drive/root:/{path}:/workbook/{resource}
```

## Common Endpoints

### Drive Operations

#### Get Drive Info

```bash
GET /microsoft-excel/v1.0/me/drive
```

#### List Root Files

```bash
GET /microsoft-excel/v1.0/me/drive/root/children
```

#### Search Files

```bash
GET /microsoft-excel/v1.0/me/drive/root/search(q='.xlsx')
```

### Session Management

#### Create Session

```bash
POST /microsoft-excel/v1.0/me/drive/root:/{path}:/workbook/createSession
Content-Type: application/json

{
  "persistChanges": true
}
```

### Worksheet Operations

#### List Worksheets

```bash
GET /microsoft-excel/v1.0/me/drive/root:/workbook.xlsx:/workbook/worksheets
```

#### Create Worksheet

```bash
POST /microsoft-excel/v1.0/me/drive/root:/workbook.xlsx:/workbook/worksheets
Content-Type: application/json

{
  "name": "NewSheet"
}
```

#### Delete Worksheet

```bash
DELETE /microsoft-excel/v1.0/me/drive/root:/workbook.xlsx:/workbook/worksheets('{id}')
```

### Range Operations

#### Get Range

```bash
GET /microsoft-excel/v1.0/me/drive/root:/workbook.xlsx:/workbook/worksheets('Sheet1')/range(address='A1:B2')
```

#### Update Range

```bash
PATCH /microsoft-excel/v1.0/me/drive/root:/workbook.xlsx:/workbook/worksheets('Sheet1')/range(address='A1:B2')
Content-Type: application/json

{
  "values": [
    ["Value1", "Value2"],
    [100, 200]
  ]
}
```

#### Get Used Range

```bash
GET /microsoft-excel/v1.0/me/drive/root:/workbook.xlsx:/workbook/worksheets('Sheet1')/usedRange
```

### Table Operations

#### List Tables

```bash
GET /microsoft-excel/v1.0/me/drive/root:/workbook.xlsx:/workbook/worksheets('Sheet1')/tables
```

#### Create Table

```bash
POST /microsoft-excel/v1.0/me/drive/root:/workbook.xlsx:/workbook/worksheets('Sheet1')/tables/add
Content-Type: application/json

{
  "address": "A1:C4",
  "hasHeaders": true
}
```

#### Get Table Rows

```bash
GET /microsoft-excel/v1.0/me/drive/root:/workbook.xlsx:/workbook/tables('Table1')/rows
```

#### Add Table Row

```bash
POST /microsoft-excel/v1.0/me/drive/root:/workbook.xlsx:/workbook/tables('Table1')/rows
Content-Type: application/json

{
  "values": [["Data1", "Data2", "Data3"]]
}
```

#### Delete Table Row

```bash
DELETE /microsoft-excel/v1.0/me/drive/root:/workbook.xlsx:/workbook/tables('Table1')/rows/itemAt(index=0)
```

#### Get Table Columns

```bash
GET /microsoft-excel/v1.0/me/drive/root:/workbook.xlsx:/workbook/tables('Table1')/columns
```

### Named Items

#### List Named Items

```bash
GET /microsoft-excel/v1.0/me/drive/root:/workbook.xlsx:/workbook/names
```

### Charts

#### List Charts

```bash
GET /microsoft-excel/v1.0/me/drive/root:/workbook.xlsx:/workbook/worksheets('Sheet1')/charts
```

#### Add Chart

```bash
POST /microsoft-excel/v1.0/me/drive/root:/workbook.xlsx:/workbook/worksheets('Sheet1')/charts/add
Content-Type: application/json

{
  "type": "ColumnClustered",
  "sourceData": "A1:C4",
  "seriesBy": "Auto"
}
```

## Notes

- Only `.xlsx` files are supported (not legacy `.xls`)
- Use path-based access (`/drive/root:/{path}:`) or ID-based access (`/drive/items/{id}`)
- Table/worksheet IDs with `{` and `}` must be URL-encoded
- Sessions improve performance for multiple operations
- Sessions expire after ~5 minutes (persistent) or ~7 minutes (non-persistent)
- Range addresses use A1 notation

## Resources

- [Microsoft Graph Excel API](https://learn.microsoft.com/en-us/graph/api/resources/excel)
- [Excel Workbook Resource](https://learn.microsoft.com/en-us/graph/api/resources/workbook)
- [Excel Worksheet Resource](https://learn.microsoft.com/en-us/graph/api/resources/worksheet)
- [Excel Range Resource](https://learn.microsoft.com/en-us/graph/api/resources/range)
