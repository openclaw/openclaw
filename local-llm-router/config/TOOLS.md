# Available Tools

## Browser (browser agent)
- `browser.navigate` — Open a URL in the managed browser
- `browser.click` — Click an element by selector or text
- `browser.type` — Type text into a field
- `browser.screenshot` — Capture the current page
- `browser.extract` — Extract structured data from the page
- `browser.wait` — Wait for an element or condition

## Email (comms agent)
- `email.read` — Fetch recent emails (optionally filtered)
- `email.send` — Send an email (requires approval)
- `email.draft` — Draft an email without sending
- `email.search` — Search inbox by query

## Search (browser agent)
- `search.web` — Search the web via SearXNG
- `search.scrape` — Fetch and extract content from a URL

## Shell (coder agent)
- `shell.exec` — Run a shell command (sandboxed)
- `shell.read` — Read a file
- `shell.write` — Write a file
- `shell.edit` — Edit a file

## Git (coder agent)
- `git.status` — Show repo status
- `git.commit` — Stage and commit changes
- `git.push` — Push to remote (requires approval)
- `git.diff` — Show current diff

## Vault (browser agent)
- `vault.get` — Retrieve stored credentials for a service

## Scheduler (monitor agent)
- `cron.schedule` — Schedule a recurring task
- `cron.list` — List scheduled tasks
- `cron.cancel` — Cancel a scheduled task

## Notifications (monitor agent)
- `notify.telegram` — Send a notification via Telegram
- `notify.alert` — Send an urgent alert
