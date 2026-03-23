#!/usr/bin/env python3
"""Navigate LCR UI to find youth temple recommend expiring report."""
import asyncio, sys, subprocess, json
from playwright.async_api import async_playwright
from playwright_stealth import Stealth

USERNAME = subprocess.check_output("export PATH=$HOME/.local/bin:$PATH && pass show church/username", shell=True, text=True).strip()
PASSWORD = subprocess.check_output("export PATH=$HOME/.local/bin:$PATH && pass show church/password", shell=True, text=True).strip()

def log(msg):
    sys.stdout.write(f"{msg}\n"); sys.stdout.flush()

async def ss(page, name):
    await page.screenshot(path=f"/tmp/church_{name}.png")

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

        # Login
        log("Logging in...")
        await page.goto("https://lcr.churchofjesuschrist.org", wait_until="domcontentloaded", timeout=30000)
        await asyncio.sleep(5)
        if "id.churchofjesuschrist.org" in page.url:
            await page.locator('#username-input, input[name="username"]').first.fill(USERNAME)
            await asyncio.sleep(1)
            await page.locator('button[type="submit"]').first.click()
            await asyncio.sleep(5)
            await page.locator('input[type="password"]:visible').first.fill(PASSWORD)
            await asyncio.sleep(1)
            await page.locator('button[type="submit"]').first.click()
            await asyncio.sleep(10)
        log(f"Logged in: {page.url}")

        # Dismiss cookie banner if present
        try:
            accept = page.locator('#truste-consent-button')
            if await accept.count() > 0 and await accept.is_visible():
                await accept.click()
                await asyncio.sleep(1)
                log("Dismissed cookie banner")
        except:
            pass

        # Explore the nav menu structure — LCR uses a custom nav
        log("Exploring nav menus...")
        
        # Get all nav links from the top menu bar
        nav_html = await page.evaluate('''() => {
            const nav = document.querySelector('nav, [role="navigation"], .toolbar, header');
            return nav ? nav.innerHTML.substring(0, 5000) : "no nav found";
        }''')
        log(f"Nav HTML: {nav_html[:2000]}")

        # Get all links on the page
        all_links = await page.evaluate('''() => {
            return Array.from(document.querySelectorAll('a[href]')).map(a => ({
                text: a.innerText.trim().substring(0, 80),
                href: a.href,
                visible: a.offsetParent !== null
            })).filter(a => a.text && (a.href.includes('temple') || a.href.includes('recommend') || a.href.includes('report')));
        }''')
        log(f"Temple/recommend/report links: {json.dumps(all_links, indent=2)}")

        # Try clicking the Temple nav dropdown
        log("Clicking Temple nav item...")
        temple_nav = await page.evaluate('''() => {
            const items = document.querySelectorAll('[class*="menu"] a, nav a, [slot="toolsMenuItem"]');
            const results = [];
            for (const item of items) {
                results.push({text: item.innerText.trim(), href: item.href, tag: item.tagName, class: item.className.substring(0,50)});
            }
            return results;
        }''')
        for item in temple_nav[:30]:
            log(f"  Nav item: '{item['text']}' -> {item['href'][:80]}")

        # LCR is a SPA — the nav items may use the top toolbar
        # Let's try hovering/clicking on "Temple" in the toolbar
        toolbar_items = page.locator('.toolbar a, .toolbar button, [class*="menuLink"], [class*="nav"] a')
        tc = await toolbar_items.count()
        log(f"Toolbar items: {tc}")
        for i in range(min(tc, 20)):
            txt = (await toolbar_items.nth(i).inner_text()).strip()[:50]
            vis = await toolbar_items.nth(i).is_visible()
            if txt and vis:
                log(f"  Toolbar {i}: '{txt}' visible={vis}")

        # The LCR toolbar has: Membership, Callings, Ministering and Welfare, Finance, Missionary, Temple, Reports, Help
        # Click on "Temple" dropdown
        temple_btn = page.locator('text=Temple').first
        try:
            await temple_btn.hover()
            await asyncio.sleep(2)
            await ss(page, "rec_v2_01_temple_hover")
            
            # Check for dropdown items
            dropdown_items = page.locator('[role="menu"] a, [role="listbox"] a, .dropdown a, .cdk-overlay-container a, [class*="dropdown"] a')
            dc = await dropdown_items.count()
            log(f"Dropdown items after hover: {dc}")
            for i in range(min(dc, 10)):
                txt = (await dropdown_items.nth(i).inner_text()).strip()[:80]
                href = await dropdown_items.nth(i).get_attribute("href") or ""
                log(f"  Dropdown: '{txt}' -> {href}")
        except Exception as e:
            log(f"Temple hover error: {e}")

        # Try clicking Temple
        try:
            await temple_btn.click()
            await asyncio.sleep(3)
            await ss(page, "rec_v2_02_temple_click")
            log(f"URL after Temple click: {page.url}")
            body = (await page.inner_text("body"))[:2000]
            log(f"Body: {body[:1000]}")
        except Exception as e:
            log(f"Temple click error: {e}")

        # Try the home page dashboard — it shows "Temple Recommend Status" widget
        # The dashboard had "Youth with Recommend 57% 17/30"
        # Click on that
        log("Going back to home for temple recommend widget...")
        await page.goto("https://lcr.churchofjesuschrist.org/", wait_until="domcontentloaded", timeout=30000)
        await asyncio.sleep(5)
        
        # Look for Temple Recommend Status section
        rec_link = page.locator('a:has-text("Temple Recommend Status"), a:has-text("Recommend Status")')
        rc = await rec_link.count()
        log(f"Recommend status links: {rc}")
        if rc > 0:
            await rec_link.first.click()
            await asyncio.sleep(5)
            await ss(page, "rec_v2_03_recommend_status")
            log(f"URL: {page.url}")
            body = (await page.inner_text("body"))[:3000]
            log(f"Recommend status page: {body[:2000]}")

        # Also try intercepting XHR calls to find the API
        log("Intercepting API calls...")
        api_calls = []
        page.on("response", lambda resp: api_calls.append({"url": resp.url, "status": resp.status}) if "api" in resp.url.lower() else None)
        
        await page.goto("https://lcr.churchofjesuschrist.org/", wait_until="networkidle", timeout=30000)
        await asyncio.sleep(5)
        
        for call in api_calls:
            log(f"  API call: {call['status']} {call['url'][:120]}")

        await ss(page, "rec_v2_99_final")
        await browser.close()

asyncio.run(main())
