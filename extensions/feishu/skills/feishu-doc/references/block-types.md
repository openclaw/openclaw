# Feishu Block Types Reference（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Complete reference for Feishu document block types. Use with `feishu_doc_list_blocks`, `feishu_doc_update_block`, and `feishu_doc_delete_block`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Block Type Table（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| block_type | Name            | Description                    | Editable |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| ---------- | --------------- | ------------------------------ | -------- |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| 1          | Page            | Document root (contains title) | No       |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| 2          | Text            | Plain text paragraph           | Yes      |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| 3          | Heading1        | H1 heading                     | Yes      |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| 4          | Heading2        | H2 heading                     | Yes      |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| 5          | Heading3        | H3 heading                     | Yes      |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| 6          | Heading4        | H4 heading                     | Yes      |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| 7          | Heading5        | H5 heading                     | Yes      |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| 8          | Heading6        | H6 heading                     | Yes      |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| 9          | Heading7        | H7 heading                     | Yes      |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| 10         | Heading8        | H8 heading                     | Yes      |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| 11         | Heading9        | H9 heading                     | Yes      |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| 12         | Bullet          | Unordered list item            | Yes      |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| 13         | Ordered         | Ordered list item              | Yes      |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| 14         | Code            | Code block                     | Yes      |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| 15         | Quote           | Blockquote                     | Yes      |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| 16         | Equation        | LaTeX equation                 | Partial  |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| 17         | Todo            | Checkbox / task item           | Yes      |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| 18         | Bitable         | Multi-dimensional table        | No       |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| 19         | Callout         | Highlight block                | Yes      |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| 20         | ChatCard        | Chat card embed                | No       |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| 21         | Diagram         | Diagram embed                  | No       |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| 22         | Divider         | Horizontal rule                | No       |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| 23         | File            | File attachment                | No       |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| 24         | Grid            | Grid layout container          | No       |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| 25         | GridColumn      | Grid column                    | No       |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| 26         | Iframe          | Embedded iframe                | No       |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| 27         | Image           | Image                          | Partial  |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| 28         | ISV             | Third-party widget             | No       |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| 29         | MindnoteBlock   | Mindmap embed                  | No       |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| 30         | Sheet           | Spreadsheet embed              | No       |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| 31         | Table           | Table                          | Partial  |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| 32         | TableCell       | Table cell                     | Yes      |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| 33         | View            | View embed                     | No       |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| 34         | Undefined       | Unknown type                   | No       |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| 35         | QuoteContainer  | Quote container                | No       |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| 36         | Task            | Lark Tasks integration         | No       |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| 37         | OKR             | OKR integration                | No       |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| 38         | OKRObjective    | OKR objective                  | No       |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| 39         | OKRKeyResult    | OKR key result                 | No       |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| 40         | OKRProgress     | OKR progress                   | No       |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| 41         | AddOns          | Add-ons block                  | No       |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| 42         | JiraIssue       | Jira issue embed               | No       |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| 43         | WikiCatalog     | Wiki catalog                   | No       |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| 44         | Board           | Board embed                    | No       |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| 45         | Agenda          | Agenda block                   | No       |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| 46         | AgendaItem      | Agenda item                    | No       |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| 47         | AgendaItemTitle | Agenda item title              | No       |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| 48         | SyncedBlock     | Synced block reference         | No       |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Editing Guidelines（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Text-based blocks (2-17, 19)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Update text content using `feishu_doc_update_block`:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "doc_token": "ABC123",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "block_id": "block_xxx",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "content": "New text content"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Image blocks (27)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Images cannot be updated directly via `update_block`. Use `feishu_doc_write` or `feishu_doc_append` with markdown to add new images.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Table blocks (31)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Important:** Table blocks CANNOT be created via the `documentBlockChildren.create` API (error 1770029). This affects `feishu_doc_write` and `feishu_doc_append` - markdown tables will be skipped with a warning.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Tables can only be read (via `list_blocks`) and individual cells (type 32) can be updated, but new tables cannot be inserted programmatically via markdown.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Container blocks (24, 25, 35)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Grid and QuoteContainer are layout containers. Edit their child blocks instead.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Common Patterns（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Replace specific paragraph（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. `feishu_doc_list_blocks` - find the block_id（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. `feishu_doc_update_block` - update its content（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Insert content at specific location（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Currently, the API only supports appending to document end. For insertion at specific positions, consider:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Read existing content（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. Delete affected blocks（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. Rewrite with new content in desired order（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Delete multiple blocks（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Blocks must be deleted one at a time. Delete child blocks before parent containers.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
