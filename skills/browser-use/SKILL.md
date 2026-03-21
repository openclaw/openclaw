---
name: browser-use
description: Automates browser interactions for web testing, form filling, screenshots, and data extraction. Use when the user needs to navigate websites, interact with web pages, fill forms, take screenshots, or extract information from web pages.
homepage: https://github.com/browser-use/browser-use
metadata:
  {
    "openclaw":
      {
        "emoji": "🌐",
        "requires": { "bins": ["browser-use"] },
        "install":
          [
            {
              "id": "uv",
              "kind": "uv",
              "package": "browser-use",
              "bins": ["browser-use"],
              "label": "Install browser-use (uv)",
            },
          ],
      },
  }
---

# Browser Automation with browser-use CLI

The `browser-use` command provides fast, persistent browser automation. It maintains browser sessions across commands, enabling complex multi-step workflows.

## Prerequisites

Before using this skill, `browser-use` must be installed and configured. Run diagnostics to verify:

```bash
browser-use doctor
```

For more information, see https://github.com/browser-use/browser-use/blob/main/browser_use/skill_cli/README.md

## Core Workflow

1. **Navigate**: `browser-use open <url>` - Opens URL (starts browser if needed)
2. **Inspect**: `browser-use state` - Returns clickable elements with indices
3. **Interact**: Use indices from state to interact (`browser-use click 5`, `browser-use input 3 "text"`)
4. **Verify**: `browser-use state` or `browser-use screenshot` to confirm actions
5. **Repeat**: Browser stays open between commands

## Browser Modes

```bash
browser-use --browser chromium open <url>      # Default: headless Chromium
browser-use --browser chromium --headed open <url>  # Visible Chromium window
browser-use --browser real open <url>          # Real Chrome (no profile = fresh)
browser-use --browser real --profile "Default" open <url>  # Real Chrome with your login sessions
browser-use --browser remote open <url>        # Cloud browser
```

- **chromium**: Fast, isolated, headless by default
- **real**: Uses a real Chrome binary. Without `--profile`, uses a persistent but empty CLI profile at `~/.config/browseruse/profiles/cli/`. With `--profile "ProfileName"`, copies your actual Chrome profile (cookies, logins, extensions)
- **remote**: Cloud-hosted browser with proxy support. **Two distinct usage modes:**
  - **Interactive** (`browser-use --browser remote open/state/click/cookies`): Spawns a persistent local server process that holds a live connection to a cloud browser. Each interactive connection consumes a concurrent cloud session slot and persists until you run `browser-use close`.
  - **Cloud agent tasks** (`browser-use -b remote run "task"`, `session create`, `task status`): Pure API calls — no local process, no held connection. The agent runs entirely in the cloud. Use `session create` to configure the browser (profile, proxy), then `run --session-id` to launch tasks.
  - **Do NOT mix these.** If you use interactive remote commands (e.g. `cookies import`) on a cloud session, the local server process holds that session open and blocks `run` from using it. For subagents, always use `session create` → `run --session-id` — never interactive remote commands.

## Essential Commands

```bash
# Navigation
browser-use open <url>                    # Navigate to URL
browser-use back                          # Go back
browser-use scroll down                   # Scroll down (--amount N for pixels)

# Page State (always run state first to get element indices)
browser-use state                         # Get URL, title, clickable elements
browser-use screenshot                    # Take screenshot (base64)
browser-use screenshot path.png           # Save screenshot to file

# Interactions (use indices from state)
browser-use click <index>                 # Click element
browser-use type "text"                   # Type into focused element
browser-use input <index> "text"          # Click element, then type
browser-use keys "Enter"                  # Send keyboard keys
browser-use select <index> "option"       # Select dropdown option

# Data Extraction
browser-use eval "document.title"         # Execute JavaScript
browser-use get text <index>              # Get element text
browser-use get html --selector "h1"      # Get scoped HTML

# Wait
browser-use wait selector "h1"            # Wait for element
browser-use wait text "Success"           # Wait for text

# Session
browser-use sessions                      # List active sessions
browser-use close                         # Close current session
browser-use close --all                   # Close all sessions

# AI Agent
browser-use -b remote run "task"          # Run agent in cloud (async by default)
browser-use task status <id>              # Check cloud task progress
```

## Commands

### Navigation & Tabs

```bash
browser-use open <url>                    # Navigate to URL
browser-use back                          # Go back in history
browser-use scroll down                   # Scroll down
browser-use scroll up                     # Scroll up
browser-use scroll down --amount 1000     # Scroll by specific pixels (default: 500)
browser-use switch <tab>                  # Switch to tab by index
browser-use close-tab                     # Close current tab
browser-use close-tab <tab>              # Close specific tab
```

### Page State

```bash
browser-use state                         # Get URL, title, and clickable elements
browser-use screenshot                    # Take screenshot (outputs base64)
browser-use screenshot path.png           # Save screenshot to file
browser-use screenshot --full path.png    # Full page screenshot
```

### Interactions

```bash
browser-use click <index>                 # Click element
browser-use type "text"                   # Type text into focused element
browser-use input <index> "text"          # Click element, then type text
browser-use keys "Enter"                  # Send keyboard keys
browser-use keys "Control+a"              # Send key combination
browser-use select <index> "option"       # Select dropdown option
browser-use hover <index>                 # Hover over element (triggers CSS :hover)
browser-use dblclick <index>              # Double-click element
browser-use rightclick <index>            # Right-click element (context menu)
```

Use indices from `browser-use state`.

### JavaScript & Data

```bash
browser-use eval "document.title"         # Execute JavaScript, return result
browser-use get title                     # Get page title
browser-use get html                      # Get full page HTML
browser-use get html --selector "h1"      # Get HTML of specific element
browser-use get text <index>              # Get text content of element
browser-use get value <index>             # Get value of input/textarea
browser-use get attributes <index>        # Get all attributes of element
browser-use get bbox <index>              # Get bounding box (x, y, width, height)
```

### Cookies

```bash
browser-use cookies get                   # Get all cookies
browser-use cookies get --url <url>       # Get cookies for specific URL
browser-use cookies set <name> <value>    # Set a cookie
browser-use cookies set name val --domain .example.com --secure --http-only
browser-use cookies set name val --same-site Strict  # SameSite: Strict, Lax, or None
browser-use cookies set name val --expires 1735689600  # Expiration timestamp
browser-use cookies clear                 # Clear all cookies
browser-use cookies clear --url <url>     # Clear cookies for specific URL
browser-use cookies export <file>         # Export all cookies to JSON file
browser-use cookies export <file> --url <url>  # Export cookies for specific URL
browser-use cookies import <file>         # Import cookies from JSON file
```

### Wait Conditions

```bash
browser-use wait selector "h1"            # Wait for element to be visible
browser-use wait selector ".loading" --state hidden  # Wait for element to disappear
browser-use wait selector "#btn" --state attached    # Wait for element in DOM
browser-use wait text "Success"           # Wait for text to appear
browser-use wait selector "h1" --timeout 5000  # Custom timeout in ms
```

### Python Execution

```bash
browser-use python "x = 42"               # Set variable
browser-use python "print(x)"             # Access variable (outputs: 42)
browser-use python "print(browser.url)"   # Access browser object
browser-use python --vars                 # Show defined variables
browser-use python --reset                # Clear Python namespace
browser-use python --file script.py       # Execute Python file
```

The Python session maintains state across commands. The `browser` object provides:

- `browser.url`, `browser.title`, `browser.html` — page info
- `browser.goto(url)`, `browser.back()` — navigation
- `browser.click(index)`, `browser.type(text)`, `browser.input(index, text)`, `browser.keys(keys)` — interactions
- `browser.screenshot(path)`, `browser.scroll(direction, amount)` — visual
- `browser.wait(seconds)`, `browser.extract(query)` — utilities

### Agent Tasks

#### Remote Mode Options

When using `--browser remote`, additional options are available:

```bash
# Specify LLM model
browser-use -b remote run "task" --llm gpt-4o
browser-use -b remote run "task" --llm claude-sonnet-4-20250514

# Proxy configuration (default: us)
browser-use -b remote run "task" --proxy-country uk

# Session reuse
browser-use -b remote run "task 1" --keep-alive        # Keep session alive after task
browser-use -b remote run "task 2" --session-id abc-123 # Reuse existing session

# Execution modes
browser-use -b remote run "task" --flash       # Fast execution mode
browser-use -b remote run "task" --wait        # Wait for completion (default: async)

# Advanced options
browser-use -b remote run "task" --thinking    # Extended reasoning mode
browser-use -b remote run "task" --no-vision   # Disable vision (enabled by default)

# Using a cloud profile (create session first, then run with --session-id)
browser-use session create --profile <cloud-profile-id> --keep-alive
# → returns session_id
browser-use -b remote run "task" --session-id <session-id>

# Task configuration
browser-use -b remote run "task" --start-url https://example.com  # Start from specific URL
browser-use -b remote run "task" --allowed-domain example.com     # Restrict navigation (repeatable)
browser-use -b remote run "task" --metadata key=value             # Task metadata (repeatable)
browser-use -b remote run "task" --skill-id skill-123             # Enable skills (repeatable)
browser-use -b remote run "task" --secret key=value               # Secret metadata (repeatable)

# Structured output and evaluation
browser-use -b remote run "task" --structured-output '{"type":"object"}'  # JSON schema for output
browser-use -b remote run "task" --judge                 # Enable judge mode
browser-use -b remote run "task" --judge-ground-truth "expected answer"
```

### Task Management

```bash
browser-use task list                     # List recent tasks
browser-use task list --limit 20          # Show more tasks
browser-use task list --status finished   # Filter by status (finished, stopped)
browser-use task list --session <id>      # Filter by session ID
browser-use task list --json              # JSON output

browser-use task status <task-id>         # Get task status (latest step only)
browser-use task status <task-id> -c      # All steps with reasoning
browser-use task status <task-id> -v      # All steps with URLs + actions
browser-use task status <task-id> --last 5  # Last N steps only
browser-use task status <task-id> --step 3  # Specific step number
browser-use task status <task-id> --reverse # Newest first

browser-use task stop <task-id>           # Stop a running task
browser-use task logs <task-id>           # Get task execution logs
```

### Cloud Session Management

```bash
browser-use session list                  # List cloud sessions
browser-use session list --limit 20       # Show more sessions
browser-use session list --status active  # Filter by status
browser-use session list --json           # JSON output

browser-use session get <session-id>      # Get session details + live URL
browser-use session get <session-id> --json

browser-use session stop <session-id>     # Stop a session
browser-use session stop --all            # Stop all active sessions

browser-use session create                          # Create with defaults
browser-use session create --profile <id>           # With cloud profile
browser-use session create --proxy-country uk       # With geographic proxy
browser-use session create --start-url https://example.com
browser-use session create --screen-size 1920x1080
browser-use session create --keep-alive
browser-use session create --persist-memory

browser-use session share <session-id>              # Create public share URL
browser-use session share <session-id> --delete     # Delete public share
```

### Tunnels

```bash
browser-use tunnel <port>           # Start tunnel (returns URL)
browser-use tunnel <port>           # Idempotent - returns existing URL
browser-use tunnel list             # Show active tunnels
browser-use tunnel stop <port>      # Stop tunnel
browser-use tunnel stop --all       # Stop all tunnels
```

### Session Management

```bash
browser-use sessions                      # List active sessions
browser-use close                         # Close current session
browser-use close --all                   # Close all sessions
```

### Profile Management

#### Local Chrome Profiles (`--browser real`)

```bash
browser-use -b real profile list          # List local Chrome profiles
browser-use -b real profile cookies "Default"  # Show cookie domains in profile
```

#### Cloud Profiles (`--browser remote`)

```bash
browser-use -b remote profile list            # List cloud profiles
browser-use -b remote profile list --page 2 --page-size 50
browser-use -b remote profile get <id>        # Get profile details
browser-use -b remote profile create          # Create new cloud profile
browser-use -b remote profile create --name "My Profile"
browser-use -b remote profile update <id> --name "New"
browser-use -b remote profile delete <id>
```

#### Syncing

```bash
browser-use profile sync --from "Default" --domain github.com  # Domain-specific
browser-use profile sync --from "Default"                      # Full profile
browser-use profile sync --from "Default" --name "Custom Name" # With custom name
```

### Server Control

```bash
browser-use server logs                   # View server logs
```

## Common Workflows

### Exposing Local Dev Servers

Use when you have a local dev server and need a cloud browser to reach it.

**Core workflow:** Start dev server → create tunnel → browse the tunnel URL remotely.

```bash
# 1. Start your dev server
npm run dev &  # localhost:3000

# 2. Expose it via Cloudflare tunnel
browser-use tunnel 3000
# → url: https://abc.trycloudflare.com

# 3. Now the cloud browser can reach your local server
browser-use --browser remote open https://abc.trycloudflare.com
browser-use state
browser-use screenshot
```

**Note:** Tunnels are independent of browser sessions. They persist across `browser-use close` and can be managed separately. Cloudflared must be installed — run `browser-use doctor` to check.

### Authenticated Browsing with Profiles

Use when a task requires browsing a site the user is already logged into (e.g. Gmail, GitHub, internal tools).

**Core workflow:** Check existing profiles → ask user which profile and browser mode → browse with that profile. Only sync cookies if no suitable profile exists.

**Before browsing an authenticated site, the agent MUST:**

1. Ask the user whether to use **real** (local Chrome) or **remote** (cloud) browser
2. List available profiles for that mode
3. Ask which profile to use
4. If no profile has the right cookies, offer to sync (see below)

#### Step 1: Check existing profiles

```bash
# Option A: Local Chrome profiles (--browser real)
browser-use -b real profile list
# → Default: Person 1 (user@gmail.com)
# → Profile 1: Work (work@company.com)

# Option B: Cloud profiles (--browser remote)
browser-use -b remote profile list
# → abc-123: "Chrome - Default (github.com)"
# → def-456: "Work profile"
```

#### Step 2: Browse with the chosen profile

```bash
# Real browser — uses local Chrome with existing login sessions
browser-use --browser real --profile "Default" open https://github.com

# Cloud browser — uses cloud profile with synced cookies
browser-use --browser remote --profile abc-123 open https://github.com
```

The user is already authenticated — no login needed.

**Note:** Cloud profile cookies can expire over time. If authentication fails, re-sync cookies from the local Chrome profile.

#### Step 3: Syncing cookies (only if needed)

If the user wants to use a cloud browser but no cloud profile has the right cookies, sync them from a local Chrome profile.

**Before syncing, the agent MUST:**

1. Ask which local Chrome profile to use
2. Ask which domain(s) to sync — do NOT default to syncing the full profile
3. Confirm before proceeding

**Check what cookies a local profile has:**

```bash
browser-use -b real profile cookies "Default"
# → youtube.com: 23
# → google.com: 18
# → github.com: 2
```

**Domain-specific sync (recommended):**

```bash
browser-use profile sync --from "Default" --domain github.com
# Creates new cloud profile: "Chrome - Default (github.com)"
# Only syncs github.com cookies
```

**Full profile sync (use with caution):**

```bash
browser-use profile sync --from "Default"
# Syncs ALL cookies — includes sensitive data, tracking cookies, every session token
```

Only use when the user explicitly needs their entire browser state.

**Fine-grained control (advanced):**

```bash
# Export cookies to file, manually edit, then import
browser-use --browser real --profile "Default" cookies export /tmp/cookies.json
browser-use --browser remote --profile <id> cookies import /tmp/cookies.json
```

**Use the synced profile:**

```bash
browser-use --browser remote --profile <id> open https://github.com
```

### Running Subagents

Use cloud sessions to run autonomous browser agents in parallel.

**Core workflow:** `session create` (with profile/proxy settings) → `run --session-id` → poll with `task status` → collect results → clean up sessions.

**IMPORTANT:** Subagents use `session create` and `run` — these are API calls with no local process. Do NOT use interactive remote browser commands (`--browser remote open`, `cookies import`, `state`, etc.) to configure sessions before running tasks. Interactive commands spawn local server processes that hold cloud session slots open and will cause `run` to fail with HTTP 429 errors.

- **Session = Agent**: Each cloud session is a browser agent with its own state
- **Task = Work**: Jobs given to an agent; an agent can run multiple tasks sequentially
- **Session lifecycle**: Once stopped, a session cannot be revived — start a new one

#### Launching Tasks

```bash
# Single task (async by default — returns immediately)
browser-use -b remote run "Search for AI news and summarize top 3 articles"
# → task_id: task-abc, session_id: sess-123

# Parallel tasks with profile + proxy — create sessions first, then launch tasks
browser-use session create --profile <cloud-profile-id> --proxy-country us --keep-alive
# → session_id: sess-a
browser-use session create --profile <cloud-profile-id> --proxy-country us --keep-alive
# → session_id: sess-b
browser-use session create --profile <cloud-profile-id> --proxy-country us --keep-alive
# → session_id: sess-c
browser-use -b remote run "Research competitor A pricing" --session-id sess-a
browser-use -b remote run "Research competitor B pricing" --session-id sess-b
browser-use -b remote run "Research competitor C pricing" --session-id sess-c

# Sequential tasks in same session (reuses cookies, login state, etc.)
browser-use -b remote run "Log into example.com" --keep-alive
# → task_id: task-1, session_id: sess-123
browser-use task status task-1  # Wait for completion
browser-use -b remote run "Export settings" --session-id sess-123
# → task_id: task-2, session_id: sess-123 (same session)
```

#### Managing & Stopping

```bash
browser-use task list --status finished      # See completed tasks
browser-use task stop task-abc               # Stop a task (session may continue if --keep-alive)
browser-use session stop sess-123            # Stop an entire session (terminates its tasks)
browser-use session stop --all               # Stop all sessions
```

#### Monitoring

**Task status is designed for token efficiency.** Default output is minimal — only expand when needed:

| Mode    | Flag   | Tokens | Use When            |
| ------- | ------ | ------ | ------------------- |
| Default | (none) | Low    | Polling progress    |
| Compact | `-c`   | Medium | Need full reasoning |
| Verbose | `-v`   | High   | Debugging actions   |

```bash
# For long tasks (50+ steps)
browser-use task status <id> -c --last 5   # Last 5 steps only
browser-use task status <id> -v --step 10  # Inspect specific step
```

**Live view**: `browser-use session get <session-id>` returns a live URL to watch the agent.

**Detect stuck tasks**: If cost/duration in `task status` stops increasing, the task is stuck — stop it and start a new agent.

**Logs**: `browser-use task logs <task-id>` — only available after task completes.

## Global Options

| Option           | Description                                                                                                                                 |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `--session NAME` | Use named session (default: "default")                                                                                                      |
| `--browser MODE` | Browser mode: chromium, real, remote                                                                                                        |
| `--headed`       | Show browser window (chromium mode)                                                                                                         |
| `--profile NAME` | Browser profile (local name or cloud ID). Works with `open`, `session create`, etc. — does NOT work with `run` (use `--session-id` instead) |
| `--json`         | Output as JSON                                                                                                                              |
| `--mcp`          | Run as MCP server via stdin/stdout                                                                                                          |

**Session behavior**: All commands without `--session` use the same "default" session. The browser stays open and is reused across commands. Use `--session NAME` to run multiple browsers in parallel.

## Tips

1. **Always run `browser-use state` first** to see available elements and their indices
2. **Use `--headed` for debugging** to see what the browser is doing
3. **Sessions persist** — the browser stays open between commands
4. **Use `--json`** for programmatic parsing
5. **Python variables persist** across `browser-use python` commands within a session
6. **CLI aliases**: `bu`, `browser`, and `browseruse` all work identically to `browser-use`

## Troubleshooting

**Run diagnostics first:**

```bash
browser-use doctor
```

**Browser won't start?**

```bash
browser-use close --all               # Close all sessions
browser-use --headed open <url>       # Try with visible window
```

**Element not found?**

```bash
browser-use state                     # Check current elements
browser-use scroll down               # Element might be below fold
browser-use state                     # Check again
```

**Session issues?**

```bash
browser-use sessions                  # Check active sessions
browser-use close --all               # Clean slate
browser-use open <url>                # Fresh start
```

**Session reuse fails after `task stop`**:
If you stop a task and try to reuse its session, the new task may get stuck at "created" status. Create a new session instead:

```bash
browser-use session create --profile <profile-id> --keep-alive
browser-use -b remote run "new task" --session-id <new-session-id>
```

**Task stuck at "started"**: Check cost with `task status` — if not increasing, the task is stuck. View live URL with `session get`, then stop and start a new agent.

**Sessions persist after tasks complete**: Tasks finishing doesn't auto-stop sessions. Run `browser-use session stop --all` to clean up.

## Cleanup

**Always close the browser when done:**

```bash
browser-use close                     # Close browser session
browser-use session stop --all        # Stop cloud sessions (if any)
browser-use tunnel stop --all         # Stop tunnels (if any)
```
