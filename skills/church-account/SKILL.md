# Church Account Skill

Automate login and tasks on churchofjesuschrist.org for Nate's LDS church callings (Executive Secretary, Young Men's Camp Director).

## Login

### How it works

The church uses OAuth via `id.churchofjesuschrist.org`. Navigating to any protected page (LCR, directory, etc.) redirects to the login page. The flow is:

1. Enter username → click Next
2. Enter password → click Verify
3. Redirects back to the target page with session cookies

No MFA or CAPTCHA is required. Playwright + playwright-stealth handles it cleanly.

### Credentials

Stored in password vault:

- `pass show church/username` → username
- `pass show church/password` → password

### Login script

```bash
python3 /home/jasper/openclaw/skills/church-account/scripts/login.py [--target URL] [--cookies FILE]
```

Defaults:

- `--target https://lcr.churchofjesuschrist.org`
- `--cookies /tmp/church_cookies.json`

Saves both cookies and full storage state for session reuse.

### Reusing a session

After login, use the saved storage state to skip re-authentication:

```python
from playwright.async_api import async_playwright
from playwright_stealth import Stealth

browser = await p.chromium.launch(
    headless=True, executable_path="/usr/bin/google-chrome",
    args=["--no-sandbox", "--disable-blink-features=AutomationControlled", "--disable-dev-shm-usage"]
)
context = await browser.new_context(
    viewport={"width": 1920, "height": 1080},
    user_agent="Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    storage_state="/tmp/church_cookies_state.json",
)
page = await context.new_page()
await Stealth().apply_stealth_async(page)
```

## Key URLs

| Service                        | URL                                          |
| ------------------------------ | -------------------------------------------- |
| LCR (Leader & Clerk Resources) | https://lcr.churchofjesuschrist.org          |
| Ward Directory                 | https://directory.churchofjesuschrist.org    |
| Calendar                       | https://www.churchofjesuschrist.org/calendar |
| Donations                      | https://donations.churchofjesuschrist.org    |
| Temple Reservations            | https://tos.churchofjesuschrist.org          |
| My Home                        | https://www.churchofjesuschrist.org/my-home  |
| Church Account Settings        | https://id.churchofjesuschrist.org/account   |

## LCR Overview

After login, LCR shows:

- **Ward:** Soldier Hill Ward (47198), Soldier Hill New Jersey Stake (514322)
- **Calling shown:** Ward Assistant Clerk (note: Nate's actual callings are Exec Secretary + YM Camp Director)
- Sections: Membership, Callings, Ministering & Welfare, Finance, Missionary, Temple, Reports, Help

## Notes

- Login session persists via cookies — no need to re-login every time
- Browser: headless Chrome with stealth (no detection issues)
- OAuth client_id for LCR: `0oajwqqtpz7f8r1OD357`
