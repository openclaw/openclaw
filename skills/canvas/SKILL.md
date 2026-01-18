# Canvas Skill

Display HTML content on connected Clawdbot nodes (Mac app, iOS, Android).

## Overview

The canvas tool lets you present web content on any connected node's canvas view. Great for:
- Displaying games, visualizations, dashboards
- Showing generated HTML content
- Interactive demos

## Actions

| Action | Description |
|--------|-------------|
| `present` | Show the canvas with optional URL |
| `hide` | Hide the canvas |
| `navigate` | Navigate to a new URL |
| `eval` | Execute JavaScript in the canvas |
| `snapshot` | Capture screenshot of canvas |

## Workflow

### 1. Create HTML content

Place HTML files in the canvas directory (configured in `canvasHost.root`, typically `~/clawd/canvas/`):

```bash
# Write your HTML file
cat > ~/clawd/canvas/my-game.html << 'HTML'
<!DOCTYPE html>
<html>
<head><title>My Game</title></head>
<body>
  <h1>Hello Canvas!</h1>
</body>
</html>
HTML
```

### 2. Find a connected node

List available nodes:
```bash
clawdbot nodes list
```

Look for nodes with canvas capability (Mac/iOS/Android apps).

### 3. Present the content

```
canvas action:present node:<node-id> target:<url>
```

**Important:** The canvas host server binds to the Tailscale hostname, not localhost!

**Correct URL format:**
```
http://<tailscale-hostname>:18793/__clawdbot__/canvas/<filename>.html
```

**Example:**
```
canvas action:present node:mac-63599bc4-b54d-4392-9048-b97abd58343a target:http://peters-mac-studio-1.sheep-coho.ts.net:18793/__clawdbot__/canvas/snake.html
```

### 4. Navigate to different content

```
canvas action:navigate node:<node-id> url:<new-url>
```

### 5. Take a screenshot

```
canvas action:snapshot node:<node-id>
```

### 6. Hide when done

```
canvas action:hide node:<node-id>
```

## Configuration

In `~/.clawdbot/clawdbot.json`:

```json
{
  "canvasHost": {
    "enabled": true,
    "port": 18793,
    "root": "/Users/you/clawd/canvas"
  }
}
```

## Common Issues

### White screen / content not loading

**Problem:** Canvas shows white/blank screen.

**Solution:** The canvas host server binds to Tailscale hostname. Use the full URL:
```
http://<tailscale-hostname>:18793/__clawdbot__/canvas/<file>.html
```

NOT:
```
http://127.0.0.1:18793/...  ❌
http://localhost:18793/...  ❌
```

### "node required" error

**Solution:** Always specify the `node` parameter with a valid node ID from `clawdbot nodes list`.

### "node not connected" error

**Solution:** The specified node is offline. Choose a different node that's currently connected.

### A2UI formats not working

A2UI JSON push formats are WIP. Use HTML files instead.

## Tips

- Keep HTML self-contained (inline CSS/JS) for best results
- Test your HTML locally first before presenting
- Use `snapshot` to capture what the canvas is showing
- The canvas persists until you `hide` it or navigate away

## Example: Quick Game Display

```bash
# 1. Create game HTML
cat > ~/clawd/canvas/game.html << 'HTML'
<!DOCTYPE html>
<html>
<head>
  <title>Quick Game</title>
  <style>
    body { background: #1a1a2e; color: #fff; font-family: sans-serif; }
    h1 { text-align: center; color: #00f3ff; }
  </style>
</head>
<body>
  <h1>🎮 Game Time!</h1>
</body>
</html>
HTML

# 2. Present it (replace with your node ID and hostname)
canvas action:present node:mac-xxx target:http://your-hostname:18793/__clawdbot__/canvas/game.html
```
