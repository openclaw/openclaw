---
summary: "Terminal Manager skill: manage tmux sessions from chat via /term commands"
read_when:
  - Managing terminal sessions from chat
  - Using /term commands
  - Taking terminal screenshots
title: "Terminal Manager"
---

# Terminal Manager

Manage tmux terminal sessions directly from chat. Create, monitor, control, and screenshot terminal sessions — all without leaving your messaging app.

## Requirements

- `tmux` installed on the host
- macOS or Linux
- Python 3 + Pillow (for screenshot rendering)

## How It Works

Terminal Manager uses a dedicated tmux socket (`$TMPDIR/openclaw-term.sock`) to isolate managed sessions from your regular tmux usage. All sessions created through `/term` live under this socket.

## Commands

| Command                            | Description                                         |
| ---------------------------------- | --------------------------------------------------- |
| `/term help`                       | Show command reference                              |
| `/term`                            | List all active sessions with windows and status    |
| `/term <session>`                  | Show last 50 lines of output from a session         |
| `/term <session> screenshot`       | Render session output as a macOS-style terminal PNG |
| `/term <session> send <cmd>`       | Send a command to a running session                 |
| `/term <session> kill`             | Kill a specific session                             |
| `/term <session> rename <newname>` | Rename a session                                    |
| `/term <session> window <n>`       | Show output of window n                             |
| `/term new <name> [cmd]`           | Create a new session, optionally run a command      |
| `/term clear`                      | Kill all managed sessions                           |

## Usage Examples

### Create a session and run a command

```
/term new devserver npm run dev
```

Creates a session named `devserver` and starts `npm run dev` inside it.

### Check output

```
/term devserver
```

Shows the last 50 lines of terminal output from the `devserver` session.

### Take a screenshot

```
/term devserver screenshot
```

Renders the terminal output as a styled PNG image with macOS-style title bar and traffic light buttons, then sends it to chat.

### Send a command to a running session

```
/term devserver send ls -la
```

Sends `ls -la` to the `devserver` session and shows the resulting output.

### List all sessions

```
/term
```

Displays a table of all active sessions with their window count, status, and current command.

### Get help

```
/term help
```

Shows the full command reference.

### Rename a session

```
/term devserver rename backend
```

Renames the `devserver` session to `backend`.

### View a specific window

```
/term devserver window 1
```

Shows the last 50 lines of output from window 1 of the `devserver` session.

### Attach from Terminal.app

You can also connect an existing terminal window to the managed tmux server:

```bash
tmux -S ${TMPDIR:-/tmp}/openclaw-term.sock new-session -s mywork
```

This makes that terminal visible and controllable through `/term` commands.

## Screenshot Rendering

The screenshot feature uses a Python script that renders terminal text as a PNG image styled like a macOS terminal window, including:

- Dark background (#1E1E1E)
- macOS-style title bar with red/yellow/green traffic light buttons
- Monospace font (SF Mono, Menlo, or DejaVu Sans Mono)
- Up to 80 lines of output

Falls back to ImageMagick `convert` if Pillow is not installed, or plain text as a last resort.

## Configuration

No additional configuration is required. The skill uses the default tmux socket path:

```
${TMPDIR:-/tmp}/openclaw-term.sock
```

## Skill Installation

Install via ClawHub:

```bash
openclaw skills install terminal-manager
```

Or place the skill folder in `~/.openclaw/skills/terminal-manager/`.
