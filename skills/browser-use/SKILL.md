---
name: browser-use
description: "Control a real browser through the Browser Use CLI for web automation, testing, screenshots, and data extraction."
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
              "label": "Install Browser Use CLI (uv)",
            },
          ],
      },
  }
---

# Browser Use

Use `browser-use` when a task needs a real browser: navigating websites, testing web apps, filling forms, extracting page data, or taking screenshots. The CLI is powered by Browser Harness and runs Python snippets with browser helpers already imported.

## Quick Check

```bash
browser-use --help
browser-use --doctor
```

If `browser-use` is missing, install it:

```bash
uv tool install browser-use
```

## Local Browser

Use a heredoc for multi-line browser work:

```bash
browser-use <<'PY'
new_tab("https://example.com")
wait_for_load()
print(page_info())
PY
```

On Windows PowerShell, pipe a here-string instead:

```powershell
@'
new_tab("https://example.com")
wait_for_load()
print(page_info())
'@ | browser-use
```

If the CLI cannot connect to the browser, run:

```bash
browser-use --doctor
```

If Chrome asks whether to allow remote debugging, ask the user to approve it, then retry the same `browser-use` command.

## Cloud Browsers

Use Browser Use cloud for headless servers, parallel browser work, isolated sessions, or when local Chrome should not be used. Authenticate once:

```bash
browser-use auth login
```

Or set an API key in the environment and check auth:

```bash
export BROWSER_USE_API_KEY=bu_...
browser-use auth status
```

Start a named cloud browser, then reuse the same name with `BU_NAME`:

```bash
browser-use <<'PY'
start_remote_daemon("work")
PY

BU_NAME=work browser-use <<'PY'
new_tab("https://example.com")
wait_for_load()
print(page_info())
PY
```

When cloud browser work is finished, ask before closing it:

```bash
BU_NAME=work browser-use <<'PY'
stop_remote_daemon("work")
PY
```

Remote daemons can bill until they stop or time out, so do not leave one running silently.

## Browser Workflow

- Start with `new_tab(url)`, then `wait_for_load()`.
- Use `page_info()` for current page state.
- Use `capture_screenshot()` when visual state matters.
- Use `js(...)` for DOM inspection or structured extraction.
- Use `click_at_xy(x, y)` for coordinate clicks after inspecting a screenshot.
- If login, MFA, captcha, consent, or account choice blocks progress, stop and ask the user.
- Keep task-specific helper code small and local to the current task.
