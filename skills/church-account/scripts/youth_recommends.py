#!/usr/bin/env python3
"""Retrieve youth temple recommend status from LCR."""
import asyncio, sys, subprocess, json
from playwright.async_api import async_playwright
from playwright_stealth import Stealth

USERNAME = subprocess.check_output("export PATH=$HOME/.local/bin:$PATH && pass show church/username", shell=True, text=True).strip()
PASSWORD = subprocess.check_output("export PATH=$HOME/.local/bin:$PATH && pass show church/password", shell=True, text=True).strip()

def log(msg):
    sys.stdout.write(f"{msg}\n"); sys.stdout.flush()

async def ss(page, name):
    await page.screenshot(path=f"/tmp/church_{name}.png")
    log(f"SS: /tmp/church_{name}.png")

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(
            headless=True, executable_path="/usr/bin/google-chrome",
            args=["--no-sandbox","--disable-blink-features=AutomationControlled","--disable-dev-shm-usage"]
        )
        context = await browser.new_context(
            viewport={"width":1920,"height":1080},
            user_agent="Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        )
        page = await context.new_page()
        await Stealth().apply_stealth_async(page)

        # Login via LCR
        log("Logging in...")
        await page.goto("https://lcr.churchofjesuschrist.org", wait_until="domcontentloaded", timeout=30000)
        await asyncio.sleep(5)
        
        if "id.churchofjesuschrist.org" in page.url:
            username_input = page.locator('#username-input, input[name="username"]')
            await username_input.first.fill(USERNAME)
            await asyncio.sleep(1)
            await page.locator('button[type="submit"]').first.click()
            await asyncio.sleep(5)
            pw_input = page.locator('input[type="password"]:visible')
            await pw_input.first.fill(PASSWORD)
            await asyncio.sleep(1)
            await page.locator('button[type="submit"]').first.click()
            await asyncio.sleep(10)
        
        log(f"Logged in: {page.url}")
        await ss(page, "rec_01_home")

        # Try the LCR API for temple recommends
        # LCR has internal REST APIs we can call with our session cookies
        
        # First, try the recommend status page
        log("Navigating to temple recommend status...")
        await page.goto("https://lcr.churchofjesuschrist.org/report/temple-recommend-status", wait_until="domcontentloaded", timeout=30000)
        await asyncio.sleep(5)
        await ss(page, "rec_02_recommend_page")
        log(f"URL: {page.url}")
        body = (await page.inner_text("body"))[:3000]
        log(f"Body: {body[:2000]}")

        # Try the youth-specific recommend report
        log("Trying youth recommend report...")
        await page.goto("https://lcr.churchofjesuschrist.org/report/limited-use-recommend-status", wait_until="domcontentloaded", timeout=30000)
        await asyncio.sleep(5)
        await ss(page, "rec_03_youth_recommend")
        log(f"URL: {page.url}")
        body = (await page.inner_text("body"))[:3000]
        log(f"Body: {body[:2000]}")

        # Also try the API endpoints directly
        # LCR uses internal APIs like /api/temple-recommend/...
        log("Trying LCR API for recommend data...")
        
        # Get unit number first
        api_urls = [
            "https://lcr.churchofjesuschrist.org/api/temple-recommend/recommend-status?lang=eng",
            "https://lcr.churchofjesuschrist.org/api/temple-recommend/limited-use-recommend-status?lang=eng",
            "https://lcr.churchofjesuschrist.org/api/report/temple-recommend-status?lang=eng",
        ]
        
        for api_url in api_urls:
            log(f"Trying API: {api_url}")
            try:
                resp = await page.evaluate(f'''async () => {{
                    const r = await fetch("{api_url}", {{credentials: "include"}});
                    const text = await r.text();
                    return {{status: r.status, body: text.substring(0, 5000)}};
                }}''')
                log(f"  Status: {resp['status']}")
                if resp['status'] == 200:
                    log(f"  Response: {resp['body'][:2000]}")
                    # Save full response
                    with open(f"/tmp/church_api_response_{api_urls.index(api_url)}.json", "w") as f:
                        f.write(resp['body'])
                else:
                    log(f"  Error: {resp['body'][:500]}")
            except Exception as e:
                log(f"  Exception: {e}")

        # Try navigating the UI to get youth recommend info
        log("Checking Temple menu options...")
        await page.goto("https://lcr.churchofjesuschrist.org", wait_until="domcontentloaded", timeout=30000)
        await asyncio.sleep(3)
        
        # Click Temple dropdown
        temple_menu = page.locator('a:has-text("Temple"), button:has-text("Temple")')
        if await temple_menu.count() > 0:
            await temple_menu.first.click()
            await asyncio.sleep(2)
            await ss(page, "rec_04_temple_menu")
            
            # List dropdown items
            menu_items = await page.query_selector_all('[role="menu"] a, [role="menu"] li, .dropdown-menu a, .dropdown-menu li')
            for item in menu_items[:20]:
                txt = (await item.inner_text()).strip()[:80]
                href = await item.get_attribute("href") or ""
                if txt:
                    log(f"  Temple menu: '{txt}' -> {href}")

        # Try the recommend expiring report
        log("Trying expiring recommends...")
        await page.goto("https://lcr.churchofjesuschrist.org/report/recommend-status?type=EXPIRING", wait_until="domcontentloaded", timeout=30000)
        await asyncio.sleep(5)
        await ss(page, "rec_05_expiring")
        body = (await page.inner_text("body"))[:3000]
        log(f"Expiring page: {body[:2000]}")

        # Full page screenshot for inspection
        await page.screenshot(path="/tmp/church_rec_full.png", full_page=True)
        log("Full page screenshot saved")

        await ss(page, "rec_99_final")
        await browser.close()

asyncio.run(main())
