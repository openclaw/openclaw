# Notion MCP Routing Reference

**App name:** `notion`
**Base URL proxied:** `mcp.notion.com`

## Request Headers

MCP requests use the `Mcp-Session-Id` header for session management. If not specified, the gateway initializes a new session and returns the session ID in the `Mcp-Session-Id` response header. You can include this session ID in subsequent requests to reuse the same session.

## Connection Management

Manage MCP connections at `https://ctrl.maton.ai`.

### List Connections

```bash
GET https://ctrl.maton.ai/connections?app=notion&method=MCP&status=ACTIVE
Authorization: Bearer $MATON_API_KEY
```

### Create Connection

```bash
POST https://ctrl.maton.ai/connections
Content-Type: application/json
Authorization: Bearer $MATON_API_KEY

{
  "app": "notion",
  "method": "MCP"
}
```

## API Path Pattern

```
/notion/{tool-name}
```

## MCP Reference

All MCP tools use `POST` method:

| Tool                        | Description                              | Schema                                           |
| --------------------------- | ---------------------------------------- | ------------------------------------------------ |
| `notion-search`             | Search workspace and connected services  | [schema](schemas/notion-search.json)             |
| `notion-fetch`              | Retrieve content from pages/databases    | [schema](schemas/notion-fetch.json)              |
| `notion-create-pages`       | Create pages with properties and content | [schema](schemas/notion-create-pages.json)       |
| `notion-update-page`        | Update page properties and content       | [schema](schemas/notion-update-page.json)        |
| `notion-move-pages`         | Relocate pages to new parent             | [schema](schemas/notion-move-pages.json)         |
| `notion-duplicate-page`     | Copy pages within workspace              | [schema](schemas/notion-duplicate-page.json)     |
| `notion-create-database`    | Create databases with schema             | [schema](schemas/notion-create-database.json)    |
| `notion-update-data-source` | Modify data source attributes            | [schema](schemas/notion-update-data-source.json) |
| `notion-create-comment`     | Add comments to pages/blocks             | [schema](schemas/notion-create-comment.json)     |
| `notion-get-comments`       | Retrieve page comments                   | [schema](schemas/notion-get-comments.json)       |
| `notion-get-teams`          | List workspace teams                     | [schema](schemas/notion-get-teams.json)          |
| `notion-get-users`          | List workspace users                     | [schema](schemas/notion-get-users.json)          |

## Common Endpoints

### Search

Search for pages and databases:

```bash
POST /notion/notion-search
Content-Type: application/json

{
  "query": "meeting notes",
  "query_type": "internal"
}
```

**Response:**

```json
{
  "content": [
    {
      "type": "text",
      "text": "{\"results\":[{\"id\":\"30702dc5-9a3b-8106-b51b-ed6d1bfeeed4\",\"title\":\"Meeting Summary Report\",\"url\":\"https://www.notion.so/30702dc59a3b8106b51bed6d1bfeeed4\",\"type\":\"page\",\"highlight\":\"Meeting materials\",\"timestamp\":\"2026-02-15T00:07:00.000Z\"}],\"type\":\"workspace_search\"}"
    }
  ],
  "isError": false
}
```

Search for users:

```bash
POST /notion/notion-search
Content-Type: application/json

{
  "query": "john@example.com",
  "query_type": "user"
}
```

With date filter:

```bash
POST /notion/notion-search
Content-Type: application/json

{
  "query": "quarterly report",
  "query_type": "internal",
  "filters": {
    "created_date_range": {
      "start_date": "2024-01-01",
      "end_date": "2025-01-01"
    }
  }
}
```

### Fetch Content

Fetch page by URL:

```bash
POST /notion/notion-fetch
Content-Type: application/json

{
  "id": "https://notion.so/workspace/Page-a1b2c3d4e5f67890"
}
```

**Response:**

```json
{
  "content": [
    {
      "type": "text",
      "text": "{\"metadata\":{\"type\":\"page\"},\"title\":\"Project Overview\",\"url\":\"https://www.notion.so/30702dc59a3b8106b51bed6d1bfeeed4\",\"text\":\"Here is the result of \\\"view\\\" for the Page with URL https://www.notion.so/30702dc59a3b8106b51bed6d1bfeeed4 as of 2026-02-14T22:56:21.276Z:\\n<page url=\\\"https://www.notion.so/30702dc59a3b8106b51bed6d1bfeeed4\\\">\\n<properties>\\n{\\\"title\\\":\\\"Project Overview\\\"}\\n</properties>\\n<content>\\n# Project Overview\\n\\nThis document outlines the project goals and milestones.\\n</content>\\n</page>\"}"
    }
  ],
  "isError": false
}
```

Fetch by UUID:

```bash
POST /notion/notion-fetch
Content-Type: application/json

{
  "id": "12345678-90ab-cdef-1234-567890abcdef"
}
```

Fetch data source (collection):

```bash
POST /notion/notion-fetch
Content-Type: application/json

{
  "id": "collection://12345678-90ab-cdef-1234-567890abcdef"
}
```

Include discussions:

```bash
POST /notion/notion-fetch
Content-Type: application/json

{
  "id": "page-uuid",
  "include_discussions": true
}
```

### Create Pages

Create a simple page:

```bash
POST /notion/notion-create-pages
Content-Type: application/json

{
  "pages": [
    {
      "properties": {"title": "My New Page"},
      "content": "# Introduction\n\nThis is my new page content."
    }
  ]
}
```

**Response:**

```json
{
  "content": [
    {
      "type": "text",
      "text": "{\"pages\":[{\"id\":\"31502dc5-9a3b-816d-a2ac-e9b7ec9aece7\",\"url\":\"https://www.notion.so/31502dc59a3b816da2ace9b7ec9aece7\",\"properties\":{\"title\":\"My New Page\"}}]}"
    }
  ],
  "isError": false
}
```

Create page under parent:

```bash
POST /notion/notion-create-pages
Content-Type: application/json

{
  "parent": {"page_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890"},
  "pages": [
    {
      "properties": {"title": "Child Page"},
      "content": "# Child Page Content"
    }
  ]
}
```

Create page in data source (database):

```bash
POST /notion/notion-create-pages
Content-Type: application/json

{
  "parent": {"data_source_id": "f336d0bc-b841-465b-8045-024475c079dd"},
  "pages": [
    {
      "properties": {
        "Task Name": "New Task",
        "Status": "In Progress",
        "Priority": 5,
        "Is Complete": "__NO__",
        "date:Due Date:start": "2024-12-25"
      }
    }
  ]
}
```

### Update Page

Update properties:

```bash
POST /notion/notion-update-page
Content-Type: application/json

{
  "page_id": "f336d0bc-b841-465b-8045-024475c079dd",
  "command": "update_properties",
  "properties": {
    "title": "Updated Page Title",
    "Status": "Done"
  }
}
```

**Response:**

```json
{
  "content": [
    {
      "type": "text",
      "text": "{\"page_id\":\"f336d0bc-b841-465b-8045-024475c079dd\"}"
    }
  ],
  "isError": false
}
```

Replace entire content:

```bash
POST /notion/notion-update-page
Content-Type: application/json

{
  "page_id": "f336d0bc-b841-465b-8045-024475c079dd",
  "command": "replace_content",
  "new_str": "# New Heading\n\nCompletely replaced content."
}
```

Replace content range:

```bash
POST /notion/notion-update-page
Content-Type: application/json

{
  "page_id": "f336d0bc-b841-465b-8045-024475c079dd",
  "command": "replace_content_range",
  "selection_with_ellipsis": "# Old Section...end of section",
  "new_str": "# New Section\n\nUpdated section content."
}
```

Insert content after:

```bash
POST /notion/notion-update-page
Content-Type: application/json

{
  "page_id": "f336d0bc-b841-465b-8045-024475c079dd",
  "command": "insert_content_after",
  "selection_with_ellipsis": "## Previous section...",
  "new_str": "\n## New Section\n\nInserted content here."
}
```

### Move Pages

Move to page:

```bash
POST /notion/notion-move-pages
Content-Type: application/json

{
  "page_or_database_ids": ["31502dc5-9a3b-816d-a2ac-e9b7ec9aece7"],
  "new_parent": {
    "page_id": "31502dc5-9a3b-81e4-b090-c6f705459e38"
  }
}
```

**Response:**

```json
{
  "content": [
    {
      "type": "text",
      "text": "{\"result\":\"Successfully moved 1 item: 31502dc5-9a3b-816d-a2ac-e9b7ec9aece7\"}"
    }
  ],
  "isError": false
}
```

Move to workspace:

```bash
POST /notion/notion-move-pages
Content-Type: application/json

{
  "page_or_database_ids": ["page-id-1", "page-id-2"],
  "new_parent": {
    "type": "workspace"
  }
}
```

Move to database:

```bash
POST /notion/notion-move-pages
Content-Type: application/json

{
  "page_or_database_ids": ["page-id"],
  "new_parent": {
    "data_source_id": "f336d0bc-b841-465b-8045-024475c079dd"
  }
}
```

### Duplicate Page

```bash
POST /notion/notion-duplicate-page
Content-Type: application/json

{
  "page_id": "31502dc5-9a3b-816d-a2ac-e9b7ec9aece7"
}
```

**Response:**

```json
{
  "content": [
    {
      "type": "text",
      "text": "{\"page_id\":\"31502dc5-9a3b-812d-a865-ccac00a21f72\",\"page_url\":\"https://www.notion.so/31502dc59a3b812da865ccac00a21f72\"}"
    }
  ],
  "isError": false
}
```

### Create Database

Create with SQL DDL schema:

```bash
POST /notion/notion-create-database
Content-Type: application/json

{
  "title": "Task Database",
  "schema": "CREATE TABLE (\"Task Name\" TITLE, \"Status\" SELECT('To Do':red, 'In Progress':yellow, 'Done':green), \"Priority\" NUMBER)"
}
```

**Response:**

```json
{
  "content": [
    {
      "type": "text",
      "text": "{\"result\":\"Created database: <database url=\\\"{{https://www.notion.so/2a3cdbb18c1c475b909a84e5615c7b74}}\\\" inline=\\\"false\\\">\\nThe title of this Database is: Task Database\\n<data-sources>\\n<data-source url=\\\"{{collection://c0f0ce51-c470-4e96-8c3f-cafca780f1a0}}\\\">\\n...\"}"
    }
  ],
  "isError": false
}
```

### Update Data Source

```bash
POST /notion/notion-update-data-source
Content-Type: application/json

{
  "data_source_id": "c0f0ce51-c470-4e96-8c3f-cafca780f1a0",
  "name": "Updated Database Name"
}
```

**Response:**

```json
{
  "content": [
    {
      "type": "text",
      "text": "{\"result\":\"Updated data source: <database url=\\\"{{https://www.notion.so/2a3cdbb18c1c475b909a84e5615c7b74}}\\\">\\n...\"}"
    }
  ],
  "isError": false
}
```

### Get Comments

```bash
POST /notion/notion-get-comments
Content-Type: application/json

{
  "page_id": "30702dc5-9a3b-8106-b51b-ed6d1bfeeed4"
}
```

**Response:**

```json
{
  "content": [
    {
      "type": "text",
      "text": "{\"results\":[{\"object\":\"comment\",\"id\":\"31502dc5-9a3b-8164-aa9c-001dfb9cb942\",\"discussion_id\":\"discussion://pageId/blockId/discussionId\",\"created_time\":\"2026-02-28T20:00:00.000Z\",\"last_edited_time\":\"2026-02-28T20:00:00.000Z\",\"created_by\":{\"object\":\"user\",\"id\":\"237d872b-594c-81d6-b88e-000200ac4d04\"},\"rich_text\":[{\"type\":\"text\",\"text\":{\"content\":\"This looks great! Ready for review.\"},\"annotations\":{\"bold\":false,\"italic\":false,\"strikethrough\":false,\"underline\":false,\"code\":false,\"color\":\"default\"}}]}],\"has_more\":false}"
    }
  ],
  "isError": false
}
```

### Create Comment

```bash
POST /notion/notion-create-comment
Content-Type: application/json

{
  "page_id": "f336d0bc-b841-465b-8045-024475c079dd",
  "rich_text": [
    {
      "type": "text",
      "text": {
        "content": "This looks great! Ready for review."
      }
    }
  ]
}
```

**Response:**

```json
{
  "content": [
    {
      "type": "text",
      "text": "{\"result\":{\"status\":\"success\",\"id\":\"31502dc5-9a3b-8164-aa9c-001dfb9cb942\"}}"
    }
  ],
  "isError": false
}
```

### List Teams

```bash
POST /notion/notion-get-teams
Content-Type: application/json

{}
```

**Response:**

```json
{
  "content": [
    {
      "type": "text",
      "text": "{\"result\":{\"status\":\"success\",\"id\":\"31502dc5-9a3b-8164-aa9c-001dfb9cb942\"}}"
    }
  ],
  "isError": false
}
```

### List Users

```bash
POST /notion/notion-get-users
Content-Type: application/json

{}
```

**Response:**

```json
{
  "content": [
    {
      "type": "text",
      "text": "{\"results\":[{\"type\":\"person\",\"id\":\"237d872b-594c-81d6-b88e-000200ac4d04\",\"name\":\"John Doe\",\"email\":\"john@example.com\"},{\"type\":\"bot\",\"id\":\"b638ec59-55e9-4889-8dc1-a523ff2c8677\",\"name\":\"Notion MCP\"}],\"has_more\":false}"
    }
  ],
  "isError": false
}
```

## Property Types

When creating or updating pages in databases:

| Property Type       | Format                                         |
| ------------------- | ---------------------------------------------- |
| Title               | `"Title Property": "Page Title"`               |
| Text                | `"Text Property": "Some text"`                 |
| Number              | `"Number Property": 42`                        |
| Checkbox            | `"Checkbox Property": "__YES__"` or `"__NO__"` |
| Select              | `"Select Property": "Option Name"`             |
| Multi-select        | `"Multi Property": "Option1, Option2"`         |
| Date (start)        | `"date:Date Property:start": "2024-12-25"`     |
| Date (end)          | `"date:Date Property:end": "2024-12-31"`       |
| Date (is datetime)  | `"date:Date Property:is_datetime": 1`          |
| Place (name)        | `"place:Location:name": "Office HQ"`           |
| Place (coordinates) | `"place:Location:latitude": 37.7749`           |

**Note:** Properties named "id" or "url" must be prefixed with `userDefined:` (e.g., `"userDefined:URL"`).

## Notes

- All IDs are UUIDs (with or without hyphens)
- Use `notion-fetch` to get page/database structure before creating or updating
- For databases, fetch first to get the data source ID (`collection://...` URL)
- If multiple Notion connections exist, specify which to use with `Maton-Connection` header
- Session can be reused by passing the `Mcp-Session-Id` header from previous responses

## Resources

- [Notion MCP Overview](https://developers.notion.com/guides/mcp)
- [MCP Supported Tools](https://developers.notion.com/guides/mcp/mcp-supported-tools)
- [Maton Community](https://discord.com/invite/dBfFAcefs2)
- [Maton Support](mailto:support@maton.ai)
