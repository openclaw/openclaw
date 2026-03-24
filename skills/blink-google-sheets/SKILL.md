---
name: blink-google-sheets
description: >
  Read and write data in Google Sheets. Read cell values, update cells, append
  rows, query data ranges. Use when asked to check, update, or add data to a
  spreadsheet. Requires the spreadsheet ID from the URL.
metadata:
  { "blink": { "requires_env": ["BLINK_API_KEY", "BLINK_AGENT_ID"], "connector": "google_sheets" } }
---

# Blink Google Sheets

Access Google Sheets. Provider key: `google_sheets`.
The SPREADSHEET_ID is in the sheet URL: `https://docs.google.com/spreadsheets/d/SPREADSHEET_ID/edit`

## Read a range of cells
```bash
blink connector exec google_sheets /spreadsheets/SPREADSHEET_ID/values/Sheet1!A1:E20 GET
```

## Read the whole sheet
```bash
blink connector exec google_sheets /spreadsheets/SPREADSHEET_ID/values/Sheet1 GET
```

## Update cells
```bash
blink connector exec google_sheets /spreadsheets/SPREADSHEET_ID/values/Sheet1!A1 PUT '{
  "range": "Sheet1!A1",
  "majorDimension": "ROWS",
  "values": [["Updated value"]]
}'
```

## Append a new row
```bash
blink connector exec google_sheets "/spreadsheets/SPREADSHEET_ID/values/Sheet1:append?valueInputOption=RAW" POST '{
  "values": [["New row", "column B", "column C"]]
}'
```

## Get spreadsheet metadata (list sheets)
```bash
blink connector exec google_sheets /spreadsheets/SPREADSHEET_ID GET \
  '{"fields": "sheets.properties"}'
```

## Batch update multiple ranges
```bash
blink connector exec google_sheets /spreadsheets/SPREADSHEET_ID/values:batchUpdate POST '{
  "valueInputOption": "RAW",
  "data": [
    {"range": "Sheet1!A1", "values": [["Value 1"]]},
    {"range": "Sheet1!B1", "values": [["Value 2"]]}
  ]
}'
```

## Create a chart
First get the sheet's numeric ID via metadata, then use batchUpdate:
```bash
blink connector exec google_sheets /spreadsheets/SPREADSHEET_ID:batchUpdate POST '{
  "requests": [{
    "addChart": {
      "chart": {
        "spec": {
          "title": "My Chart",
          "basicChart": {
            "chartType": "LINE",
            "legendPosition": "BOTTOM_LEGEND",
            "domains": [{"domain": {"sourceRange": {"sources": [{"sheetId": SHEET_GID, "startRowIndex": 0, "endRowIndex": 10, "startColumnIndex": 0, "endColumnIndex": 1}]}}}],
            "series": [{"series": {"sourceRange": {"sources": [{"sheetId": SHEET_GID, "startRowIndex": 0, "endRowIndex": 10, "startColumnIndex": 1, "endColumnIndex": 2}]}}, "targetAxis": "LEFT_AXIS"}],
            "headerCount": 1
          }
        },
        "position": {"overlayPosition": {"anchorCell": {"sheetId": SHEET_GID, "rowIndex": 12, "columnIndex": 0}}}
      }
    }
  }]
}'
```
Note: `sheetId` is the numeric GID (from metadata), NOT the spreadsheet ID from the URL.

## IMPORTANT: Charts cannot be inserted into Google Docs via REST API
The Google Docs REST API does NOT support `insertSheetsChart` or `insertInlineSheetsChart`.
To embed a Sheets chart in a Google Doc, export it as an image and use the Docs API `insertInlineImage`.

## Common use cases
- "What's in my budget spreadsheet?" → read Sheet1 range
- "Add a new expense row: $50 for coffee on March 14" → append row
- "Update cell B5 to Done" → update specific cell
- "How many rows does my tracker have?" → read full sheet, count rows
- "What are this month's totals?" → read a specific range
- "Add a chart showing revenue over time" → addChart via batchUpdate
