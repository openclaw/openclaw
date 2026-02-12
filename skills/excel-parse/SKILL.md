---
name: excel-parse
description: Parse Excel (.xlsx) files and extract data as JSON.
metadata: { "openclaw": { "emoji": "📊", "requires": { "bins": ["node"] } } }
---

# Excel Parsing

Extract data from Excel files using `xlsx`.

## When to use

- "Read this excel file"
- "Extract data from [file.xlsx]"
- "Convert this spreadsheet to JSON"

## Usage

### Run Parsing Command

```bash
# Using the built-in script
node skills/excel-parse/parse.ts "input_file.xlsx"
```

The script will output the content of the first sheet as a JSON array of objects.
You can then analyze this JSON data to answer the user's questions.
