| description                                                       | argument-hint               |
| ----------------------------------------------------------------- | --------------------------- |
| Inspect an existing PenPot design file and describe its structure | \<file ID or project name\> |

## What to do

Inspect a PenPot design file and provide a clear summary of its structure.

### Steps

1. If the user provided a file ID, use `penpot_inspect_file` directly.

2. If the user provided a project name or no specific file, use `penpot_list_projects` first to find the right project, then ask which file to inspect or pick the most recent one.

3. Present the file structure clearly:
   - File name and revision number
   - List of pages with shape counts
   - For each page, describe the shape hierarchy (frames containing other shapes)
   - Note any layout properties, colors, and text content

4. Provide the PenPot workspace URL so the user can open it.

### Input

$ARGUMENTS — a file ID or project/file name to look up.
