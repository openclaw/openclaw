# OpenCode CUSTOM FORK Server API Endpoints Reference

## Base URL

`http://localhost:4200` (CUSTOM FORK - opencode-fork)

## Health Check

```
GET /global/health
```

Returns server health and version.

**Response:**

```json
{
  "healthy": true,
  "version": "1.1.49"
}
```

## Session Management

### Create Session

```
POST /session
```

Create a new OpenCode session.

**Request Body:**

```json
{
  "title": "Project: Todo App",
  "parentID": "optional-parent-session-id"
}
```

**Response:**

```json
{
  "id": "session-id",
  "title": "Project: Todo App",
  "createdAt": "2024-01-01T00:00:00.000Z",
  "updatedAt": "2024-01-01T00:00:00.000Z"
}
```

### List Sessions

```
GET /session
```

Get all sessions.

### Get Session Details

```
GET /session/:id
```

Get specific session details.

### Delete Session

```
DELETE /session/:id
```

Delete a session.

## Messaging

### Send Message

```
POST /session/:id/message
```

Send a message to OpenCode and wait for response.

**Request Body:**

```json
{
  "message": "Create a comprehensive plan for a React Todo app",
  "model": "deepseek/deepseek-chat",
  "agent": "plan", // or "build"
  "messageID": "optional-parent-message-id",
  "noReply": false,
  "system": "optional-system-prompt",
  "tools": [],
  "parts": []
}
```

**Response:**

```json
{
  "info": {
    "id": "message-id",
    "sessionID": "session-id",
    "role": "assistant",
    "createdAt": "2024-01-01T00:00:00.000Z"
  },
  "parts": [
    {
      "type": "text",
      "content": "Response text here...",
      "id": "part-id"
    }
  ]
}
```

### Get Messages

```
GET /session/:id/message
```

Get messages in a session.

**Query Parameters:**

- `limit`: Number of messages to return (default: 50)

### Get Message Details

```
GET /session/:id/message/:messageID
```

Get specific message details.

## Project & File Operations

### Get Current Project

```
GET /project/current
```

Get current project information.

### List Files

```
GET /file?path=<path>
```

List files and directories.

### Read File Content

```
GET /file/content?path=<path>
```

Read file content.

### Search Files

```
GET /find/file?query=<search-term>
```

Search for files by name.

### Search Text

```
GET /find?pattern=<search-pattern>
```

Search for text in files.

## Diff & Changes

### Get Session Diff

```
GET /session/:id/diff
```

Get file changes for a session.

**Query Parameters:**

- `messageID`: Optional message ID to get diff at specific point

**Response:**

```json
[
  {
    "path": "src/App.js",
    "oldContent": "previous content",
    "newContent": "new content",
    "added": 5,
    "removed": 2
  }
]
```

## Commands

### Execute Command

```
POST /session/:id/command
```

Execute a slash command.

**Request Body:**

```json
{
  "command": "/init",
  "arguments": [],
  "model": "deepseek/deepseek-chat",
  "agent": "plan"
}
```

### List Commands

```
GET /command
```

Get all available commands.

## Configuration

### Get Config

```
GET /config
```

Get current configuration.

### Update Config

```
PATCH /config
```

Update configuration.

### Get Providers

```
GET /config/providers
```

List available providers and default models.

## Agents

### List Agents

```
GET /agent
```

Get all available agents.

**Common Agents:**

- `plan`: Plan mode (read-only, suggests changes)
- `build`: Build mode (makes changes)
- `review`: Review mode (analyzes code)

## Events

### Event Stream

```
GET /global/event
```

Server-sent events stream for real-time updates.

## Authentication

### Set Auth Credentials

```
PUT /auth/:providerID
```

Set authentication credentials for a provider.

## Error Responses

**Common Error Format:**

```json
{
  "error": {
    "message": "Error description",
    "code": "ERROR_CODE"
  }
}
```

**Common Error Codes:**

- `SESSION_NOT_FOUND`: Session does not exist
- `INVALID_REQUEST`: Malformed request
- `SERVER_ERROR`: Internal server error
- `AUTH_REQUIRED`: Authentication required

## Rate Limiting

- Default rate limit: 60 requests per minute
- Burst: 10 requests
- Responses include headers:
  - `X-RateLimit-Limit`: Total requests allowed
  - `X-RateLimit-Remaining`: Remaining requests
  - `X-RateLimit-Reset`: Reset time (Unix timestamp)

## CORS

Default CORS settings allow `localhost` origins. Additional origins can be added with `--cors` flag when starting server.

## WebSocket Support

For real-time bidirectional communication, OpenCode supports WebSocket connections at `/ws` endpoint.
