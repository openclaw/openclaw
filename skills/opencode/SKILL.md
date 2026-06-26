---
name: opencode
description: Use CUSTOM OpenCode fork (opencode-fork) for agentic coding tasks with rigorous workflow: plan mode → detailed planning → testing → build mode → GitHub integration. Use for all coding tasks with zero exceptions, always using the custom server API at http://localhost:4200. Follow the strict 6-step workflow: 1) Discuss project details, 2) Use plan mode for detailed planning, 3) Verify plan adherence, 4) Create rigorous testing, 5) Cycle through steps 1-4 for new features, 6) GitHub commit/push workflow. Use unique custom features: autonomous agent coordination, headless permission modes, async fixes, webhook dispatch.
---

# OpenCode CUSTOM FORK Skill - Agentic Coding Platform

## Overview

OpenCode CUSTOM FORK (opencode-fork) is a custom-coded version of OpenCode specifically for J.A.R.V.I.S. use with enhanced features. This skill provides a rigorous workflow for using the CUSTOM OpenCode fork for all coding tasks with zero exceptions, always using the custom server API at `http://localhost:4200`.

## Prerequisites

- **CUSTOM OpenCode Fork**: Installed at `/home/john/.local/bin/opencode-datboi6942` (wrapper) and `/home/john/.local/bin/opencode-improved` (binary)
- **Repository**: `/home/john/opencode-fork` - Custom fork with autonomous agent coordination features
- **Primary Server**: Running on port 4200 with custom features: `opencode-datboi6942 serve --port 4200 --hostname 127.0.0.1`
- **Version**: `01.26.04-datboi6942` (custom version wrapper), `0.0.0-production-202602090801` (binary - updated with headless permission modes)
- **Default server URL**: `http://localhost:4200` (CUSTOM FORK with enhanced features)
- **Standard OpenCode DISABLED**: All standard OpenCode instances (ports 4096, 4100) must be killed, only custom fork runs
- `jq` command-line JSON processor (install with: `sudo apt-get install jq`)

## CUSTOM FEATURES (Unique to opencode-fork)

### 1. Autonomous Agent Coordination System

- **State Machine**: 7-state coordination (idle → planning → awaiting_answers → plan_ready → building → awaiting_approval → completed)
- **Webhook Dispatch**: Real-time coordination events with HMAC-SHA256 signatures
- **Coordination APIs**: `/coordination/:sessionID/*` endpoints for external agent orchestration
- **Plan/Workflow Management**: Structured workflow for rough plan → questions → verification → build stages → approval

### 2. Headless Permission Modes (NEW)

- **Webhook Mode**: Default when `OPENCODE_AUTONOMOUS_AGENT_MODE=true` - dispatches `permission.asked` events to webhook
- **Auto-Allow Mode**: Auto-approves all permissions (development only)
- **Interactive Mode**: Waits for UI response (will hang in headless mode)
- **Prevents Tool Deadlocks**: Critical for headless API servers where tools like `read`/`grep` need permissions

### 3. Async Fixes & Reliability

- **Fixed prompt_async handler**: Missing await added (commit 9d6baa570)
- **Enhanced reliability**: Better error handling and timeout management
- **Coordination timeouts**: Configurable timeouts for question answering and approval stages

### 4. Enhanced for AI Agent Workflows

- **External agent integration**: Designed for J.A.R.V.I.S. and other autonomous agents
- **Programmatic control**: Full API for agentic coordination without manual intervention
- **Event-driven architecture**: Webhooks for real-time state changes

## Core Workflow (ZERO EXCEPTIONS)

Follow this exact 6-step workflow for ALL coding tasks:

### Step 1: Project Discussion

- Discuss the project/software to develop in extensive detail with the user
- Work out all requirements, specifications, and architecture
- Document the agreed-upon plan

### Step 2: Plan Mode (DeepSeek-Reasoner)

- Use OpenCode's local server API to switch to Plan Mode
- Have OpenCode (deepseek-reasoner) develop a detailed, extensive plan with files and structure
- The plan should include: architecture, file structure, dependencies, implementation approach

### Step 3: Plan Verification

- Compare OpenCode's generated plan with the discussed plan from Step 1
- If the plan adheres to the conversed plan, proceed to Step 4
- If not, provide feedback and iterate in Plan Mode until alignment is achieved

### Step 4: Testing Planning

- Have OpenCode in Plan Mode create rigorous testing strategies
- Develop comprehensive test plans to preemptively solve problems/bugs
- Include: unit tests, integration tests, edge cases, performance testing

### Step 5: Iterative Development

- Cycle through Steps 1-4 as many times as needed for each new feature
- Each feature addition follows the same rigorous planning process

### Step 6: GitHub Workflow

- Once success criteria are met, create a GitHub repository
- Stage all changes, commit with descriptive messages
- Push to remote repository
- For feature additions/chores/bug fixes: verify changes, stage, commit to current repo

## API Usage

### Server Management (CUSTOM FORK ONLY)

```bash
# KILL ALL STANDARD OPENCODE INSTANCES FIRST
sudo systemctl --user stop opencode.service 2>/dev/null
sudo systemctl --user disable opencode.service 2>/dev/null
pkill -9 -f "opencode.*serve" 2>/dev/null
pkill -9 -f "opencode.*4096" 2>/dev/null
pkill -9 -f "opencode.*4100" 2>/dev/null

# Start CUSTOM FORK server (background) - PORT 4200 ONLY
/home/john/.local/bin/opencode-datboi6942 serve --port 4200 --hostname 127.0.0.1 > /tmp/opencode-fork.log 2>&1 &

# Check server health
curl -s http://localhost:4200/global/health
```

### Complete API Reference

#### Global Endpoints

```bash
# Health check
curl -s http://localhost:4200/global/health

# Global events (SSE stream)
curl -s http://localhost:4200/global/event
```

#### Project Management

```bash
# List all projects
curl -s http://localhost:4200/project

# Get current project
curl -s http://localhost:4200/project/current
```

#### Path & VCS

```bash
# Get current path
curl -s http://localhost:4200/path

# Get VCS info
curl -s http://localhost:4200/vcs
```

#### Instance Management

```bash
# Dispose current instance
curl -X POST http://localhost:4200/instance/dispose
```

#### Configuration

```bash
# Get config
curl -s http://localhost:4200/config

# Update config
curl -X PATCH http://localhost:4200/config \
  -H "Content-Type: application/json" \
  -d '{"key": "value"}'

# List providers and default models
curl -s http://localhost:4200/config/providers
```

#### Provider Management

```bash
# List all providers
curl -s http://localhost:4200/provider

# Get provider auth methods
curl -s http://localhost:4200/provider/auth

# Authorize provider via OAuth
curl -X POST http://localhost:4200/provider/{id}/oauth/authorize \
  -H "Content-Type: application/json" \
  -d '{"provider": "github"}'

# Handle OAuth callback
curl -X POST http://localhost:4200/provider/{id}/oauth/callback \
  -H "Content-Type: application/json" \
  -d '{"code": "auth_code"}'
```

#### Session Management (CRITICAL: Must create session first!)

```bash
# CREATE SESSION FIRST (REQUIRED for all operations)
curl -X POST http://localhost:4200/session \
  -H "Content-Type: application/json" \
  -d '{"title": "Project: [Project Name]"}' | jq -r '.id'
# Returns: "ses_3cbb5ffd5ffeWRhLUfWfPFhwgI" (save this ID!)

# List all sessions
curl -s http://localhost:4200/session

# Get session status for all sessions
curl -s http://localhost:4200/session/status

# Get session details
curl -s http://localhost:4200/session/[SESSION_ID]

# Delete session
curl -X DELETE http://localhost:4200/session/[SESSION_ID]

# Update session properties
curl -X PATCH http://localhost:4200/session/[SESSION_ID] \
  -H "Content-Type: application/json" \
  -d '{"title": "Updated Title"}'

# Get child sessions
curl -s http://localhost:4200/session/[SESSION_ID]/children

# Get todo list
curl -s http://localhost:4200/session/[SESSION_ID]/todo

# Initialize session (create AGENTS.md)
curl -X POST http://localhost:4200/session/[SESSION_ID]/init \
  -H "Content-Type: application/json" \
  -d '{"messageID": "msg_123", "providerID": "deepseek", "modelID": "deepseek-chat"}'

# Fork session
curl -X POST http://localhost:4200/session/[SESSION_ID]/fork \
  -H "Content-Type: application/json" \
  -d '{"messageID": "msg_123"}'

# Abort running session
curl -X POST http://localhost:4200/session/[SESSION_ID]/abort

# Share session
curl -X POST http://localhost:4200/session/[SESSION_ID]/share

# Unshare session
curl -X DELETE http://localhost:4200/session/[SESSION_ID]/share

# Get session diff
curl -s "http://localhost:4200/session/[SESSION_ID]/diff?messageID=msg_123"

# Summarize session
curl -X POST http://localhost:4200/session/[SESSION_ID]/summarize \
  -H "Content-Type: application/json" \
  -d '{"providerID": "deepseek", "modelID": "deepseek-chat"}'

# Revert message
curl -X POST http://localhost:4200/session/[SESSION_ID]/revert \
  -H "Content-Type: application/json" \
  -d '{"messageID": "msg_123"}'

# Unrevert all messages
curl -X POST http://localhost:4200/session/[SESSION_ID]/unrevert

# Respond to permission request
curl -X POST http://localhost:4200/session/[SESSION_ID]/permissions/[PERMISSION_ID] \
  -H "Content-Type: application/json" \
  -d '{"response": "allow", "remember": true}'
```

#### Message Operations (CRITICAL: Use async endpoint - FIXED in custom fork!)

```bash
# List messages (poll for responses)
curl -s "http://localhost:4200/session/[SESSION_ID]/message?limit=50"

# ⚠️ WARNING: Synchronous endpoint HANGS (Issue #11865) - Still applies
# DO NOT USE: curl -X POST http://localhost:4200/session/[SESSION_ID]/message

# ✅ CORRECT: Send message asynchronously (returns HTTP 204 immediately)
# Custom fork has FIXED prompt_async handler (commit 9d6baa570)
curl -X POST http://localhost:4200/session/[SESSION_ID]/prompt_async \
  -H "Content-Type: application/json" \
  -d '{
    "parts": [{"type": "text", "text": "[Your prompt here]"}],
    "model": {"providerID": "deepseek", "modelID": "deepseek-chat"},
    "agent": "plan"  # or "build" for build mode
  }'
# Returns: HTTP 204 No Content (success)

# Then poll for messages:
# sleep 5 && curl -s "http://localhost:4200/session/[SESSION_ID]/message?limit=50"

# Get message details
curl -s http://localhost:4200/session/[SESSION_ID]/message/[MESSAGE_ID]

# Execute slash command
curl -X POST http://localhost:4200/session/[SESSION_ID]/command \
  -H "Content-Type: application/json" \
  -d '{
    "command": "/plan",
    "arguments": ["Create todo app"]
  }'

# Run shell command
curl -X POST http://localhost:4200/session/[SESSION_ID]/shell \
  -H "Content-Type: application/json" \
  -d '{
    "agent": "build",
    "command": "ls -la"
  }'
```

#### Commands

```bash
# List all commands
curl -s http://localhost:4200/command
```

#### File Operations

```bash
# Search text in files
curl -s "http://localhost:4200/find?pattern=function"

# Find files by name
curl -s "http://localhost:4200/find/file?query=main.js"

# Find workspace symbols
curl -s "http://localhost:4200/find/symbol?query=Component"

# List files and directories
curl -s "http://localhost:4200/file?path=/home/user/project"

# Read file content
curl -s "http://localhost:4200/file/content?path=/home/user/project/main.js"

# Get tracked files status
curl -s http://localhost:4200/file/status
```

#### Tools (Experimental)

```bash
# List tool IDs
curl -s http://localhost:4200/experimental/tool/ids

# List tools for model
curl -s "http://localhost:4200/experimental/tool?provider=openai&model=gpt-4"
```

#### LSP, Formatters & MCP

```bash
# Get LSP server status
curl -s http://localhost:4200/lsp

# Get formatter status
curl -s http://localhost:4200/formatter

# Get MCP server status
curl -s http://localhost:4200/mcp

# Add MCP server dynamically
curl -X POST http://localhost:4200/mcp \
  -H "Content-Type: application/json" \
  -d '{"name": "my-server", "config": {"command": "npx", "args": ["my-mcp"]}}'
```

#### Agents

```bash
# List all agents
curl -s http://localhost:4200/agent
```

#### Coordination APIs (CUSTOM FORK FEATURE - Autonomous Agent Workflows)

Enable autonomous agent mode first:

```bash
export OPENCODE_AUTONOMOUS_AGENT_MODE=true
export OPENCODE_WEBHOOK_URL=https://your-agent.example.com/webhooks
export OPENCODE_WEBHOOK_SECRET=your-secret-key

# Headless Permission Mode (NEW - prevents tool deadlocks)
export OPENCODE_HEADLESS_PERMISSION_MODE=webhook  # or auto-allow, interactive

# Optional timeouts
export OPENCODE_COORDINATION_QUESTION_TIMEOUT_MS=300000  # 5 minutes
export OPENCODE_COORDINATION_APPROVAL_TIMEOUT_MS=600000  # 10 minutes
export OPENCODE_APPROVAL_TIMEOUT_MS=300000               # 5 minutes
```

```bash
# Get coordination state
curl -s http://localhost:4200/coordination/:sessionID/state

# Submit rough plan (starts planning workflow)
curl -X POST http://localhost:4200/coordination/:sessionID/plan/submit \
  -H "Content-Type: application/json" \
  -d '{
    "roughPlan": "Implement feature X",
    "externalAgentId": "jarvis-agent-123"
  }'

# Get pending questions
curl -s http://localhost:4200/coordination/:sessionID/plan/questions

# Answer question
curl -X POST http://localhost:4200/coordination/:sessionID/plan/answer \
  -H "Content-Type: application/json" \
  -d '{
    "questionId": "q123",
    "answer": "Use approach Y"
  }'

# Verify plan
curl -X POST http://localhost:4200/coordination/:sessionID/plan/verify \
  -H "Content-Type: application/json" \
  -d '{"verified": true}'

# Get plan status
curl -s http://localhost:4200/coordination/:sessionID/plan/status

# Approve build stage
curl -X POST http://localhost:4200/coordination/:sessionID/build/approve \
  -H "Content-Type: application/json" \
  -d '{
    "stage": "implement-feature",
    "approved": true
  }'

# Set session-specific webhook URL
curl -X POST http://localhost:4200/coordination/:sessionID/webhook \
  -H "Content-Type: application/json" \
  -d '{"webhookUrl": "https://custom-webhook.example.com"}'
```

#### Headless Permission Modes (NEW - Prevents Tool Deadlocks)

When running OpenCode as a headless API server, tools like `read` and `grep` request permissions that would normally wait for interactive approval. To prevent deadlocks, configure headless permission modes:

```bash
# Webhook Mode (default when OPENCODE_AUTONOMOUS_AGENT_MODE=true)
export OPENCODE_HEADLESS_PERMISSION_MODE=webhook
# Dispatches permission.asked events to your webhook with timeout handling

# Auto-Allow Mode (development only)
export OPENCODE_HEADLESS_PERMISSION_MODE=auto-allow
# Auto-approves all permissions immediately

# Interactive Mode (will hang in headless mode)
export OPENCODE_HEADLESS_PERMISSION_MODE=interactive
# Waits for UI response - NOT RECOMMENDED for headless servers
```

**Webhook Event Format:**

```json
{
  "type": "permission.asked",
  "sessionId": "ses_...",
  "permissionId": "perm_...",
  "tool": "read",
  "path": "/path/to/file",
  "timeoutMs": 30000
}
```

**Response Required Within Timeout:**

```bash
curl -X POST http://localhost:4200/session/[SESSION_ID]/permissions/[PERMISSION_ID] \
  -H "Content-Type: application/json" \
  -d '{"response": "allow", "remember": true}'
```

#### Logging

```bash
# Write log entry
curl -X POST http://localhost:4200/log \
  -H "Content-Type: application/json" \
  -d '{"service": "opencode", "level": "info", "message": "Test log"}'
```

#### TUI Control

```bash
# Append text to prompt
curl -X POST http://localhost:4200/tui/append-prompt \
  -H "Content-Type: application/json" \
  -d '{"text": "echo hello"}'

# Open help dialog
curl -X POST http://localhost:4200/tui/open-help

# Open session selector
curl -X POST http://localhost:4200/tui/open-sessions

# Open theme selector
curl -X POST http://localhost:4200/tui/open-themes

# Open model selector
curl -X POST http://localhost:4200/tui/open-models

# Submit current prompt
curl -X POST http://localhost:4200/tui/submit-prompt

# Clear prompt
curl -X POST http://localhost:4200/tui/clear-prompt

# Execute command
curl -X POST http://localhost:4200/tui/execute-command \
  -H "Content-Type: application/json" \
  -d '{"command": "/plan"}'

# Show toast
curl -X POST http://localhost:4200/tui/show-toast \
  -H "Content-Type: application/json" \
  -d '{"title": "Info", "message": "Operation complete", "variant": "success"}'

# Wait for next control request
curl -s http://localhost:4200/tui/control/next

# Respond to control request
curl -X POST http://localhost:4200/tui/control/response \
  -H "Content-Type: application/json" \
  -d '{"body": "response data"}'
```

#### Authentication

```bash
# Set auth credentials
curl -X PUT http://localhost:4200/auth/[PROVIDER_ID] \
  -H "Content-Type: application/json" \
  -d '{"apiKey": "your-api-key"}'
```

#### Events

```bash
# Server-sent events stream
curl -s http://localhost:4200/event
```

#### Documentation

```bash
# OpenAPI 3.1 specification
curl -s http://localhost:4200/doc
```

#### Switch Modes

- **Plan Mode**: Set `"agent": "plan"` in message request
- **Build Mode**: Set `"agent": "build"` in message request
- Use Tab key equivalent via API: The mode is controlled by the `agent` parameter

## Workflow Implementation Scripts

### 1. Project Initialization Script

Create a new project session with proper context:

```bash
#!/bin/bash
# scripts/init_project.sh
SESSION_ID=$(curl -s -X POST http://localhost:4200/session \
  -H "Content-Type: application/json" \
  -d '{"title": "Project: $1"}' | jq -r '.id')

echo "Session created: $SESSION_ID"
echo $SESSION_ID > /tmp/opencode_current_session.txt
```

### 2. Plan Mode Execution (Async)

```bash
#!/bin/bash
# scripts/plan_mode.sh
SESSION_ID=$(cat /tmp/opencode_current_session.txt 2>/dev/null)
if [ -z "$SESSION_ID" ]; then
  echo "No active session. Run init_project.sh first."
  exit 1
fi

# Send async request (returns immediately) - CUSTOM FORK with fixed async
curl -X POST http://localhost:4200/session/$SESSION_ID/prompt_async \
  -H "Content-Type: application/json" \
  -d '{
    "parts": [{"type": "text", "text": "'"$1"'"}],
    "model": {"providerID": "deepseek", "modelID": "deepseek-chat"},
    "agent": "plan"
  }'

echo "Request sent asynchronously. Poll /session/$SESSION_ID/message for responses."
```

### 3. Build Mode Execution (Async)

```bash
#!/bin/bash
# scripts/build_mode.sh
SESSION_ID=$(cat /tmp/opencode_current_session.txt 2>/dev/null)
if [ -z "$SESSION_ID" ]; then
  echo "No active session. Run init_project.sh first."
  exit 1
fi

# Send async request (returns immediately) - CUSTOM FORK with fixed async
curl -X POST http://localhost:4200/session/$SESSION_ID/prompt_async \
  -H "Content-Type: application/json" \
  -d '{
    "parts": [{"type": "text", "text": "'"$1"'"}],
    "model": {"providerID": "deepseek", "modelID": "deepseek-chat"},
    "agent": "build"
  }'

echo "Request sent asynchronously. Poll /session/$SESSION_ID/message for responses."
```

## GitHub Integration

### Repository Creation & Management

```bash
# Initialize git repository
git init
git add .
git commit -m "Initial commit: [Project description]"

# Create GitHub repository (requires gh CLI)
gh repo create [repo-name] --public --source=. --remote=origin --push
```

### Feature Branch Workflow

```bash
# Create feature branch
git checkout -b feature/[feature-name]

# After development
git add .
git commit -m "feat: [feature description]"
git push origin feature/[feature-name]

# Create pull request
gh pr create --title "[PR title]" --body "[PR description]"
```

## Headless API Workflow Discovery (2026-02-06)

### Critical Discovery: Session Creation Required

After extensive debugging, discovered that OpenCode's async endpoint **REQUIRES session creation first**. Sessions are NOT auto-created.

### Correct Headless API Workflow:

1. **Create Session**: `POST /session` → Returns session ID (`ses_...`)
2. **Send Async Message**: `POST /session/{id}/prompt_async` → Returns HTTP 204
3. **Poll for Responses**: `GET /session/{id}/message` → Returns message array

### Why Earlier Tests Failed:

- Direct async calls to non-existent sessions return HTTP 204 but don't process
- Session files are only created via `POST /session` endpoint
- `SessionPrompt.prompt()` assumes session exists, doesn't create if missing

### Validated Servers:

- **Port 4100**: Version 1.1.53 with DeepSeek configured (primary)
- **Port 4096**: Version 1.1.49 (legacy, works with same workflow)

## Error Handling & Best Practices

### Server Issues

- Always verify server health before API calls
- If server not running, start it with background process
- Check logs: `/tmp/opencode-server.log`

### Session Management

- Store current session ID in `/tmp/opencode_current_session.txt`
- Verify session exists before operations
- Clean up old sessions periodically

### Plan Mode Rigor

- Never skip plan mode for new features
- Ensure comprehensive testing plans are created
- Validate plan adherence before build mode

### GitHub Discipline

- Always commit with descriptive messages
- Use conventional commits: feat:, fix:, chore:, docs:
- Push changes immediately after verification

## Example Workflow

### Starting a New Project

1. `./scripts/init_project.sh "Todo App"`
2. Discuss requirements with user
3. `./scripts/plan_mode.sh "Create a comprehensive plan for a React Todo app with TypeScript, local storage, and unit tests"`
4. Review and verify plan
5. `./scripts/plan_mode.sh "Create rigorous testing strategy including unit tests for all components, integration tests for state management, and edge case testing"`
6. `./scripts/build_mode.sh "Implement the planned Todo app according to the approved plan"`
7. Initialize git, commit, push to GitHub

## Troubleshooting

### Common Issues

1. **Server not responding**: Check if process is running: `ps aux | grep opencode`
2. **Session expired**: Create new session and update session file
3. **API errors**: Verify JSON formatting and endpoint URLs
4. **Plan not detailed enough**: Provide more specific requirements in Step 1
5. **Tool permission deadlocks**: Ensure `OPENCODE_HEADLESS_PERMISSION_MODE=webhook` or `auto-allow` for headless servers
6. **Webhook timeouts**: Check `OPENCODE_APPROVAL_TIMEOUT_MS` and ensure webhook responds within timeout

### Debug Commands

```bash
# Check server status
curl -s http://localhost:4200/global/health | jq .

# List sessions
curl -s http://localhost:4200/session | jq .

# Get session status for all sessions
curl -s http://localhost:4200/session/status | jq .

# List providers
curl -s http://localhost:4200/provider | jq .

# Check MCP server status
curl -s http://localhost:4200/mcp | jq .

# View server logs
tail -f /tmp/opencode-server.log
```

## References

- OpenCode Documentation: https://opencode.ai/docs
- Server API: https://opencode.ai/docs/server/
- GitHub CLI: https://cli.github.com/
- Complete API Reference: See `opencode-api-documentation.md` in workspace for full endpoint details
- **Custom Fork Documentation**: See `/home/john/opencode-fork/packages/web/src/content/docs/autonomous-agents.mdx` for headless permission modes and coordination system
- **Custom Fork Repository**: `/home/john/opencode-fork` - Latest commits with TypeScript fixes and headless permission modes

---

**Remember**: Zero exceptions to this workflow. All coding tasks must follow the 6-step process using the local server API.
