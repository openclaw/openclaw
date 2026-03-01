---
name: feishu-sheets
description: |
  Feishu spreadsheet range read operations. Activate when users mention sheet links, A1 ranges, or data extraction tasks.
---

# Feishu Sheets Read Tool

Tool: `feishu_sheets_read_range`

## Required Parameters

- `spreadsheet_token`: Spreadsheet token
- `sheet_id`: Sheet ID inside the spreadsheet
- `range` (optional): A1 range like `A1:C5`

## Optional Parameters

- `include_markdown`: Include a markdown preview under `markdown`

## Read Behavior

- If `range` is omitted, the tool tries to infer a read window from sheet metadata.
- When metadata is unavailable, fallback range is `A1:Z1000`.
- If the sheet is large, response may include `next_range_hint` for resumable reads.

## Request Example

```json
{
  "spreadsheet_token": "ssp_xxx",
  "sheet_id": "sh_xxx",
  "range": "A1:C10"
}
```

## Success Response

- `values`: 2D array
- `value_range`: range metadata (`range`, `major_dimension`, `row_count`, `column_count`)
- `sheet_meta`: sheet metadata (title, row/column caps)
- `next_range_hint`: optional follow-up range suggestion

## Configuration

```yaml
channels:
  feishu:
    tools:
      sheets: true # default: true
```

## Permissions

- `sheet:sheet` or `sheet:sheet:readonly`
