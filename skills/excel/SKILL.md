---
name: excel
description: Read, write, edit, and format Excel files (.xlsx). Create spreadsheets, manipulate data, apply formatting, manage sheets, merge cells, find/replace, and export to CSV/JSON/Markdown. Use for any Excel file manipulation task.
metadata: {"clawdbot":{"emoji":"📊","requires":{"bins":["python3"],"pip":["openpyxl"]}}}
---

# Excel

Comprehensive Excel file manipulation - read, write, edit, format, and export.

## Setup

```bash
pip install openpyxl

# Or use uv (recommended)
uv run --with openpyxl python3 scripts/excel.py --help
```

## Quick Reference

```bash
cd skills/excel

# Get file info
python3 scripts/excel.py info report.xlsx

# Read entire sheet
python3 scripts/excel.py read report.xlsx
python3 scripts/excel.py read report.xlsx --format markdown
python3 scripts/excel.py read report.xlsx --sheet "Sales" --range A1:D10

# Read specific cell
python3 scripts/excel.py cell report.xlsx B5

# Create new workbook
python3 scripts/excel.py create output.xlsx
python3 scripts/excel.py create output.xlsx --sheets "Data,Summary,Charts"

# Write data
python3 scripts/excel.py write output.xlsx --data '[[1,2,3],[4,5,6]]'
python3 scripts/excel.py write output.xlsx --data '{"headers":["Name","Age"],"rows":[["Alice",30],["Bob",25]]}'

# Edit a cell
python3 scripts/excel.py edit report.xlsx A1 "New Value"
python3 scripts/excel.py edit report.xlsx B2 "SUM(A1:A10)" --formula

# Export
python3 scripts/excel.py to-csv report.xlsx output.csv
python3 scripts/excel.py to-json report.xlsx output.json
python3 scripts/excel.py to-markdown report.xlsx
```

## Commands

### Reading Data

**info** - Get workbook metadata
```bash
python3 scripts/excel.py info report.xlsx
# Returns: sheets, dimensions, row/column counts
```

**read** - Read sheet data
```bash
python3 scripts/excel.py read file.xlsx                     # JSON output
python3 scripts/excel.py read file.xlsx --format csv        # CSV output
python3 scripts/excel.py read file.xlsx --format markdown   # Markdown table
python3 scripts/excel.py read file.xlsx --sheet "Sheet2"    # Specific sheet
python3 scripts/excel.py read file.xlsx --range A1:D10      # Specific range
```

**cell** - Read a specific cell
```bash
python3 scripts/excel.py cell file.xlsx A1
python3 scripts/excel.py cell file.xlsx B5 --sheet "Data"
# Returns: value, formula (if any), data type, merge status
```

### Creating & Writing

**create** - Create new workbook
```bash
python3 scripts/excel.py create new.xlsx
python3 scripts/excel.py create new.xlsx --sheets "Sheet1,Sheet2,Summary"
```

**write** - Write data to cells
```bash
# 2D array
python3 scripts/excel.py write file.xlsx --data '[[1,2,3],[4,5,6]]'

# With headers
python3 scripts/excel.py write file.xlsx --data '{"headers":["A","B"],"rows":[[1,2],[3,4]]}'

# Start at specific cell
python3 scripts/excel.py write file.xlsx --data '[[1,2]]' --start C5

# Key-value pairs
python3 scripts/excel.py write file.xlsx --data '{"Name":"Alice","Age":30}'
```

**from-csv** - Create Excel from CSV
```bash
python3 scripts/excel.py from-csv data.csv output.xlsx
python3 scripts/excel.py from-csv data.csv output.xlsx --sheet "Imported"
```

**from-json** - Create Excel from JSON
```bash
python3 scripts/excel.py from-json data.json output.xlsx
# Supports: array of objects, array of arrays, headers+rows format
```

### Editing

**edit** - Edit a cell value or formula
```bash
python3 scripts/excel.py edit file.xlsx A1 "New Value"
python3 scripts/excel.py edit file.xlsx B2 100
python3 scripts/excel.py edit file.xlsx C3 "SUM(A1:B2)" --formula
python3 scripts/excel.py edit file.xlsx D4 "=VLOOKUP(A1,Data!A:B,2,FALSE)" --formula
```

**find** - Search for text
```bash
python3 scripts/excel.py find file.xlsx "search term"
python3 scripts/excel.py find file.xlsx "error" --sheet "Log"
# Returns: list of cells containing the text
```

**replace** - Find and replace
```bash
python3 scripts/excel.py replace file.xlsx "old" "new"
python3 scripts/excel.py replace file.xlsx "2024" "2025" --sheet "Dates"
```

### Sheet Management

**add-sheet** - Add a new sheet
```bash
python3 scripts/excel.py add-sheet file.xlsx "NewSheet"
python3 scripts/excel.py add-sheet file.xlsx "First" --position 0  # Insert at beginning
```

**rename-sheet** - Rename a sheet
```bash
python3 scripts/excel.py rename-sheet file.xlsx "Sheet1" "Data"
```

**delete-sheet** - Delete a sheet
```bash
python3 scripts/excel.py delete-sheet file.xlsx "OldSheet"
```

**copy-sheet** - Copy a sheet
```bash
python3 scripts/excel.py copy-sheet file.xlsx "Template" "January"
```

### Row & Column Operations

**insert-rows** - Insert rows
```bash
python3 scripts/excel.py insert-rows file.xlsx 5              # Insert 1 row at row 5
python3 scripts/excel.py insert-rows file.xlsx 5 --count 3    # Insert 3 rows
```

**insert-cols** - Insert columns
```bash
python3 scripts/excel.py insert-cols file.xlsx C              # Insert at column C
python3 scripts/excel.py insert-cols file.xlsx 3 --count 2    # Insert 2 cols at position 3
```

**delete-rows** - Delete rows
```bash
python3 scripts/excel.py delete-rows file.xlsx 5
python3 scripts/excel.py delete-rows file.xlsx 5 --count 3
```

**delete-cols** - Delete columns
```bash
python3 scripts/excel.py delete-cols file.xlsx C
python3 scripts/excel.py delete-cols file.xlsx B --count 2
```

### Cell Operations

**merge** - Merge cells
```bash
python3 scripts/excel.py merge file.xlsx A1:C1
python3 scripts/excel.py merge file.xlsx A1:A5 --sheet "Header"
```

**unmerge** - Unmerge cells
```bash
python3 scripts/excel.py unmerge file.xlsx A1:C1
```

### Formatting

**format** - Apply cell formatting
```bash
# Bold and italic
python3 scripts/excel.py format file.xlsx A1:D1 --bold --italic

# Font settings
python3 scripts/excel.py format file.xlsx A1:D1 --font-size 14 --font-color RED --font-name "Arial"

# Background color
python3 scripts/excel.py format file.xlsx A1:D1 --bg-color YELLOW

# Alignment
python3 scripts/excel.py format file.xlsx A:A --align center --valign top

# Text wrapping
python3 scripts/excel.py format file.xlsx B2:B100 --wrap

# Borders
python3 scripts/excel.py format file.xlsx A1:D10 --border thin
# Border styles: thin, medium, thick, double

# Combined
python3 scripts/excel.py format file.xlsx A1:D1 --bold --bg-color "#4472C4" --font-color WHITE --align center
```

**resize** - Resize rows and columns
```bash
python3 scripts/excel.py resize file.xlsx --row 1:30          # Row 1 height = 30
python3 scripts/excel.py resize file.xlsx --col A:20          # Column A width = 20
python3 scripts/excel.py resize file.xlsx --row 1:30 --col A:15 --col B:25
```

**freeze** - Freeze panes
```bash
python3 scripts/excel.py freeze file.xlsx A2    # Freeze row 1
python3 scripts/excel.py freeze file.xlsx B1    # Freeze column A
python3 scripts/excel.py freeze file.xlsx B2    # Freeze row 1 and column A
```

### Export

**to-csv** - Export to CSV
```bash
python3 scripts/excel.py to-csv file.xlsx output.csv
python3 scripts/excel.py to-csv file.xlsx data.csv --sheet "Data"
```

**to-json** - Export to JSON (first row as headers)
```bash
python3 scripts/excel.py to-json file.xlsx output.json
# Outputs: [{"Header1": "val1", "Header2": "val2"}, ...]
```

**to-markdown** - Export to markdown table
```bash
python3 scripts/excel.py to-markdown file.xlsx
python3 scripts/excel.py to-markdown file.xlsx --sheet "Summary"
```

## Colors

Named colors: `RED`, `GREEN`, `BLUE`, `YELLOW`, `WHITE`, `BLACK`, `GRAY`, `ORANGE`, `PURPLE`, `PINK`, `CYAN`

Hex colors: `#FF0000`, `#4472C4`, `00FF00` (with or without #)

## Common Workflows

### Create a report from data
```bash
# Create workbook with data
python3 scripts/excel.py from-json sales.json report.xlsx --sheet "Sales"

# Format headers
python3 scripts/excel.py format report.xlsx A1:E1 --bold --bg-color "#4472C4" --font-color WHITE

# Freeze header row
python3 scripts/excel.py freeze report.xlsx A2

# Resize columns
python3 scripts/excel.py resize report.xlsx --col A:15 --col B:25 --col C:12
```

### Update existing report
```bash
# Add new row
python3 scripts/excel.py insert-rows report.xlsx 2
python3 scripts/excel.py write report.xlsx --data '[["New Item", 100, 50]]' --start A2

# Update specific cell
python3 scripts/excel.py edit report.xlsx D10 "=SUM(D2:D9)" --formula

# Find and replace dates
python3 scripts/excel.py replace report.xlsx "2024" "2025"
```

### Extract data for analysis
```bash
# Read as JSON for processing
python3 scripts/excel.py read data.xlsx --format json > data.json

# Read specific range as markdown
python3 scripts/excel.py read data.xlsx --range A1:D20 --format markdown

# Export specific sheet to CSV
python3 scripts/excel.py to-csv data.xlsx --sheet "Raw Data" export.csv
```

## Output Format

All commands output JSON with `success: true/false`:

```json
{
  "success": true,
  "file": "report.xlsx",
  "sheet": "Sheet1",
  ...
}
```

Use `--format markdown` or `--format csv` with `read` command for alternative output.
