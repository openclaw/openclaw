# @openclaw/browser-cli

Standalone browser control CLI for OpenClaw using playwright-core via Chrome DevTools Protocol (CDP).

## Why?

On Linux systems (tested on Ubuntu 22.04/24.04), OpenClaw's built-in browser tool `act` actions (click, type, fill) can timeout due to pointer event interception issues. This CLI bypasses those issues by connecting directly to Chrome via CDP. May also help on other systems experiencing similar timeouts.

## Prerequisites

Start Chrome with remote debugging enabled:

```bash
google-chrome --remote-debugging-port=18800 --user-data-dir=/tmp/chrome-debug
```

## Installation

```bash
# Global install
npm install -g @openclaw/browser-cli

# Or use npx
npx @openclaw/browser-cli navigate "https://example.com"
```

## Usage

```bash
# Navigation
browser navigate "https://google.com"

# Click elements (supports text=, css selectors, xpath)
browser click "text=Sign In"
browser click "button[type=submit]"
browser click "#login-btn"

# Type into fields
browser type "input[name=email]" "user@example.com"
browser type "#password" "secret123"

# Press keyboard keys
browser press Enter
browser press Tab
browser press Escape

# Get page content
browser snapshot           # First 2000 chars
browser snapshot 5000      # First 5000 chars

# Take screenshot
browser screenshot                    # Saves to /tmp/screenshot.png
browser screenshot ./my-screenshot.png

# Execute JavaScript
browser eval "document.title"
browser eval "document.querySelector('h1').innerText"

# Fill multiple fields at once
browser fill "input[name=user]=john,input[name=pass]=secret"

# Wait for element
browser wait "text=Loading complete"
browser wait "#results" 30000

# Get current page info
browser info
```

## Environment Variables

| Variable  | Default                  | Description                  |
| --------- | ------------------------ | ---------------------------- |
| `CDP_URL` | `http://127.0.0.1:18800` | Chrome DevTools Protocol URL |

## Selectors

The CLI supports Playwright's selector syntax:

- `text=Submit` - Match by text content
- `text="Exact Match"` - Exact text match
- `#id` - CSS ID selector
- `.class` - CSS class selector
- `button[type=submit]` - CSS attribute selector
- `xpath=//button` - XPath selector

## Output

All commands output JSON for easy parsing:

```json
{ "ok": true, "url": "https://example.com", "title": "Example" }
```

On error:

```json
{ "ok": false, "error": "Cannot connect to Chrome..." }
```

## Troubleshooting

### "Cannot connect to Chrome"

Make sure Chrome is running with remote debugging:

```bash
google-chrome --remote-debugging-port=18800 --user-data-dir=/tmp/chrome-debug
```

### "No page found"

Open at least one tab in Chrome before running commands.

### Custom CDP port

```bash
CDP_URL=http://127.0.0.1:9222 browser navigate "https://example.com"
```

## License

MIT
