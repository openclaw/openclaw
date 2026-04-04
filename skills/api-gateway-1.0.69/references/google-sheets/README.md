# Google Sheets Routing Reference

**App name:** `google-sheets`
**Base URL proxied:** `sheets.googleapis.com`

## API Path Pattern

```
/google-sheets/v4/spreadsheets/{spreadsheetId}/{endpoint}
```

## Common Endpoints

### Get Spreadsheet Metadata

```bash
GET /google-sheets/v4/spreadsheets/{spreadsheetId}
```

### Get Values

```bash
GET /google-sheets/v4/spreadsheets/{spreadsheetId}/values/{range}
```

Example:

```bash
GET /google-sheets/v4/spreadsheets/SHEET_ID/values/Sheet1!A1:D10
```

### Get Multiple Ranges

```bash
GET /google-sheets/v4/spreadsheets/{spreadsheetId}/values:batchGet?ranges=Sheet1!A1:B10&ranges=Sheet2!A1:C5
```

### Update Values

```bash
PUT /google-sheets/v4/spreadsheets/{spreadsheetId}/values/{range}?valueInputOption=USER_ENTERED
Content-Type: application/json

{
  "values": [
    ["A1", "B1", "C1"],
    ["A2", "B2", "C2"]
  ]
}
```

### Append Values

```bash
POST /google-sheets/v4/spreadsheets/{spreadsheetId}/values/{range}:append?valueInputOption=USER_ENTERED
Content-Type: application/json

{
  "values": [
    ["New Row 1", "Data", "More Data"],
    ["New Row 2", "Data", "More Data"]
  ]
}
```

### Batch Update Values

```bash
POST /google-sheets/v4/spreadsheets/{spreadsheetId}/values:batchUpdate
Content-Type: application/json

{
  "valueInputOption": "USER_ENTERED",
  "data": [
    {"range": "Sheet1!A1:B2", "values": [["A1", "B1"], ["A2", "B2"]]},
    {"range": "Sheet1!D1:E2", "values": [["D1", "E1"], ["D2", "E2"]]}
  ]
}
```

### Clear Values

```bash
POST /google-sheets/v4/spreadsheets/{spreadsheetId}/values/{range}:clear
```

### Create Spreadsheet

```bash
POST /google-sheets/v4/spreadsheets
Content-Type: application/json

{
  "properties": {"title": "New Spreadsheet"},
  "sheets": [{"properties": {"title": "Sheet1"}}]
}
```

### Batch Update (formatting, add sheets, etc.)

```bash
POST /google-sheets/v4/spreadsheets/{spreadsheetId}:batchUpdate
Content-Type: application/json

{
  "requests": [
    {"addSheet": {"properties": {"title": "New Sheet"}}}
  ]
}
```

## Common batchUpdate Requests

See [full list of request types](https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets/request).

### Update Cells with Formatting

```json
{
  "updateCells": {
    "rows": [
      {
        "values": [
          { "userEnteredValue": { "stringValue": "Name" } },
          { "userEnteredValue": { "numberValue": 100 } }
        ]
      }
    ],
    "fields": "userEnteredValue",
    "start": { "sheetId": 0, "rowIndex": 0, "columnIndex": 0 }
  }
}
```

### Format Header Row (Bold + Background Color)

```json
{
  "repeatCell": {
    "range": {
      "sheetId": 0,
      "startRowIndex": 0,
      "endRowIndex": 1,
      "startColumnIndex": 0,
      "endColumnIndex": 3
    },
    "cell": {
      "userEnteredFormat": {
        "backgroundColor": { "red": 0.2, "green": 0.6, "blue": 0.9 },
        "textFormat": { "bold": true }
      }
    },
    "fields": "userEnteredFormat(backgroundColor,textFormat)"
  }
}
```

### Auto-Resize Columns

```json
{
  "autoResizeDimensions": {
    "dimensions": { "sheetId": 0, "dimension": "COLUMNS", "startIndex": 0, "endIndex": 3 }
  }
}
```

### Rename Sheet

```json
{
  "updateSheetProperties": {
    "properties": { "sheetId": 0, "title": "NewName" },
    "fields": "title"
  }
}
```

### Insert Rows/Columns

```json
{
  "insertDimension": {
    "range": { "sheetId": 0, "dimension": "ROWS", "startIndex": 1, "endIndex": 3 },
    "inheritFromBefore": true
  }
}
```

### Sort Range

```json
{
  "sortRange": {
    "range": {
      "sheetId": 0,
      "startRowIndex": 1,
      "endRowIndex": 10,
      "startColumnIndex": 0,
      "endColumnIndex": 3
    },
    "sortSpecs": [{ "dimensionIndex": 1, "sortOrder": "DESCENDING" }]
  }
}
```

### Add Conditional Formatting

```json
{
  "addConditionalFormatRule": {
    "rule": {
      "ranges": [
        {
          "sheetId": 0,
          "startRowIndex": 1,
          "endRowIndex": 10,
          "startColumnIndex": 1,
          "endColumnIndex": 2
        }
      ],
      "booleanRule": {
        "condition": { "type": "NUMBER_GREATER_THAN_EQ", "values": [{ "userEnteredValue": "90" }] },
        "format": { "backgroundColor": { "red": 0.7, "green": 1, "blue": 0.7 } }
      }
    },
    "index": 0
  }
}
```

### Add Filter

```json
{
  "setBasicFilter": {
    "filter": {
      "range": {
        "sheetId": 0,
        "startRowIndex": 0,
        "endRowIndex": 100,
        "startColumnIndex": 0,
        "endColumnIndex": 5
      }
    }
  }
}
```

### Delete Sheet

```json
{
  "deleteSheet": { "sheetId": 123456789 }
}
```

## Value Input Options

- `RAW` - Values are stored as-is
- `USER_ENTERED` - Values are parsed as if typed into the UI (formulas executed, numbers parsed)

## Range Notation

- `Sheet1!A1:D10` - Specific range
- `Sheet1!A:D` - Entire columns A through D
- `Sheet1!1:10` - Entire rows 1 through 10
- `Sheet1` - Entire sheet
- `A1:D10` - Range in first sheet

## Notes

- Authentication is automatic - the router injects the OAuth token
- Range in URL path must be URL-encoded (`!` → `%21`, `:` → `%3A`)
- Use `valueInputOption=USER_ENTERED` to parse formulas and numbers
- Delete spreadsheets via Google Drive API

## Resources

- [API Overview](https://developers.google.com/workspace/sheets/api/reference/rest)
- [Get Spreadsheet](https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets/get)
- [Create Spreadsheet](https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets/create)
- [Batch Update](https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets/batchUpdate)
- [Batch Update Request Types](https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets/request)
- [Get Values](https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets.values/get)
- [Update Values](https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets.values/update)
- [Append Values](https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets.values/append)
- [Batch Get Values](https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets.values/batchGet)
- [Batch Update Values](https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets.values/batchUpdate)
- [Clear Values](https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets.values/clear)
