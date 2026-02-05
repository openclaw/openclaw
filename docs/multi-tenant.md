# Multi-Tenant Support

OpenClaw supports multi-tenant deployments through tenant context propagation and MCP (Model Context Protocol) credential isolation. This enables secure, scalable deployment where multiple organizations, workspaces, and users can share the same OpenClaw instance while maintaining data isolation.

## Overview

Multi-tenant support in OpenClaw provides:

- **Tenant Context Propagation**: HTTP headers carry organization, workspace, team, and user identifiers through the request lifecycle
- **Session-Based Context Storage**: Tenant context is persisted in session metadata for the duration of conversations
- **System Prompt Integration**: The AI agent receives tenant identity information in its system prompt
- **MCP Credential Isolation**: External service credentials (HubSpot, BigQuery, etc.) are isolated per tenant
- **Tenant-Aware Responses**: The agent understands which organization/user is making requests

## Architecture

### Tenant Hierarchy

OpenClaw uses a four-level tenant hierarchy:

```
Organization (Primary)
  └─ Workspace (Optional)
      └─ Team (Optional)
          └─ User (Optional)
```

- **Organization ID**: Required for multi-tenant MCP access. Primary tenant identifier.
- **Workspace ID**: Optional. Allows subdividing organizations into workspaces.
- **Team ID**: Optional. Further subdivision within workspaces.
- **User ID**: Optional. Individual user identifier within the hierarchy.

### Data Flow

1. **HTTP Request**: Client sends request with tenant context headers
2. **Gateway Extraction**: OpenClaw extracts tenant identifiers from headers
3. **Session Storage**: Tenant context is stored in session metadata
4. **System Prompt**: Agent receives tenant context in its system prompt
5. **MCP Tool Calls**: Tools use tenant context for credential lookup and data scoping

## Configuration

### HTTP Headers

Send tenant context using these HTTP headers:

```http
POST /v1/chat/completions HTTP/1.1
Host: your-openclaw-instance.com
Authorization: Bearer your-api-token
x-openclaw-organization-id: org_abc123
x-openclaw-workspace-id: ws_xyz789
x-openclaw-team-id: team_dev
x-openclaw-user-id: user_john
Content-Type: application/json

{
  "model": "openclaw",
  "messages": [
    {"role": "user", "content": "Show me recent HubSpot deals"}
  ]
}
```

#### Supported Headers

Both prefixed and non-prefixed versions are supported:

| Header Name | Alternative | Description |
|-------------|-------------|-------------|
| `x-openclaw-organization-id` | `x-organization-id` | Organization identifier (required for MCP) |
| `x-openclaw-workspace-id` | `x-workspace-id` | Workspace identifier (optional) |
| `x-openclaw-team-id` | `x-team-id` | Team identifier (optional) |
| `x-openclaw-user-id` | `x-user-id` | User identifier (optional) |

### MCP Configuration

Enable MCP with multi-tenant credential storage:

```yaml
# openclaw.yaml
mcp:
  enabled: true

  # MongoDB for tenant credential storage
  credentials:
    mongoUrl: "mongodb://localhost:27017"
    database: "openclaw_mcp"
    collection: "tenant_credentials"

  # MCP server configurations
  servers:
    hubspot:
      command: "npx"
      args: ["-y", "@hubspot/mcp-server"]

    bigquery:
      command: "npx"
      args: ["-y", "@google/mcp-server-bigquery"]
```

### Credential Storage

Store tenant-specific credentials in MongoDB:

```javascript
// MongoDB document structure
{
  "_id": ObjectId("..."),
  "organizationId": "org_abc123",
  "workspaceId": "ws_xyz789",      // optional
  "teamId": "team_dev",             // optional
  "service": "hubspot",
  "credentials": {
    "HUBSPOT_ACCESS_TOKEN": "your-hubspot-token"
  },
  "createdAt": ISODate("2025-01-15T10:00:00Z"),
  "updatedAt": ISODate("2025-01-15T10:00:00Z")
}
```

Credentials are looked up using the tenant hierarchy:
1. Try exact match: organization + workspace + team
2. Fall back to: organization + workspace
3. Fall back to: organization only

## Usage Examples

### Basic Multi-Tenant Request

```bash
curl -X POST https://your-openclaw.com/v1/chat/completions \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "x-organization-id: org_acme" \
  -H "x-workspace-id: ws_sales" \
  -H "x-user-id: user_alice" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "openclaw",
    "messages": [
      {"role": "user", "content": "List my open tickets in HubSpot"}
    ]
  }'
```

### Using MCP Tools

The agent automatically uses the tenant context when calling MCP tools:

```json
{
  "messages": [
    {
      "role": "user",
      "content": "Show me BigQuery tables in the analytics dataset"
    }
  ]
}
```

The MCP tool will:
1. Extract tenant context from the session
2. Look up BigQuery credentials for the organization
3. Execute the query with those credentials
4. Return results scoped to that tenant

### System Prompt Context

The agent receives tenant information in its system prompt:

```
## Multi-Tenant Context
Organization ID: org_acme
Workspace ID: ws_sales
User ID: user_alice

This context identifies which organization, workspace, and user is making the request.
When using MCP tools (HubSpot, BigQuery, etc.), credentials and data access are scoped to this tenant context.
Always consider this context when providing answers - different organizations may have different data, policies, and requirements.
```

## Security Considerations

### Credential Isolation

- Credentials are stored per tenant in MongoDB
- MCP servers receive only the credentials for the requesting tenant
- No cross-tenant data access is possible

### Header Validation

- Always validate tenant headers on the gateway/proxy level
- Do not trust client-provided tenant IDs without authentication
- Use JWT claims or session validation to verify tenant identity

### Example: Nginx Proxy Configuration

```nginx
location /v1/ {
  # Extract tenant from JWT and add header
  auth_request /auth;
  auth_request_set $org_id $upstream_http_x_organization_id;
  auth_request_set $user_id $upstream_http_x_user_id;

  proxy_set_header x-openclaw-organization-id $org_id;
  proxy_set_header x-openclaw-user-id $user_id;

  proxy_pass http://openclaw:3000;
}

location = /auth {
  internal;
  proxy_pass http://auth-service/verify;
  proxy_pass_request_body off;
  proxy_set_header Content-Length "";
}
```

## Troubleshooting

### Agent Not Seeing Tenant Context

**Symptom**: System prompt shows no tenant context section

**Check**:
1. Verify headers are sent with request
2. Check session metadata: `~/.openclaw/sessions/<session-key>.json`
3. Enable debug logging: `OPENCLAW_LOG_LEVEL=debug`

### MCP Credential Not Found

**Symptom**: Error: "Failed to extract tenant context: Multi-tenant context not configured"

**Solution**:
- Ensure `organizationId` header is present
- Verify credentials exist in MongoDB for this organization
- Check MongoDB connection in config

### Wrong Credentials Used

**Symptom**: MCP tools return data from different organization

**Solution**:
- Verify tenant headers are correctly set
- Check credential lookup hierarchy in MongoDB
- Ensure no credential fallback to default organization

## Implementation Details

### Code Architecture

Key files for multi-tenant support:

```
src/
├── config/sessions/
│   └── types.ts                  # SessionEntry with tenant fields
├── gateway/
│   ├── http-utils.ts             # extractTenantContext()
│   ├── openai-http.ts            # OpenAI endpoint with tenant extraction
│   └── openresponses-http.ts     # OpenResponses endpoint
├── agents/
│   ├── system-prompt.ts          # buildTenantContextSection()
│   └── pi-embedded-runner/
│       ├── system-prompt.ts      # buildEmbeddedSystemPrompt()
│       └── run/attempt.ts        # Tenant context extraction from session
└── mcp-integration/
    ├── context-manager.ts        # MCPContextManager
    ├── credential-manager.ts     # MongoDB credential lookup
    └── mcp-tool.ts              # MCP tool with tenant isolation
```

### Session Metadata

Tenant context is stored in session files at `~/.openclaw/sessions/<session-key>.json`:

```json
{
  "sessionKey": "agent:main/openai-user:alice",
  "organizationId": "org_acme",
  "workspaceId": "ws_sales",
  "teamId": "team_dev",
  "userId": "user_alice",
  "createdAt": 1705320000000,
  "lastAccessedAt": 1705320123000
}
```

## Best Practices

1. **Always Set Organization ID**: Required for MCP credential isolation
2. **Use JWT for Identity**: Don't trust client headers; validate via JWT
3. **Scope Credentials Properly**: Store separate credentials per organization
4. **Log Tenant Context**: Include tenant IDs in logs for auditing
5. **Test Isolation**: Verify no cross-tenant data leaks
6. **Document Hierarchy**: Clearly define organization/workspace/team structure

## Related Documentation

- [MCP Integration](./mcp-integration.md) - Model Context Protocol setup
- [Gateway Configuration](./gateway/README.md) - Gateway deployment
- [Sessions](./sessions.md) - Session management
- [System Prompts](./system-prompts.md) - System prompt customization
