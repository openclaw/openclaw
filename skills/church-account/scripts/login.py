#!/usr/bin/env python3
"""
Church of Jesus Christ login via Playwright + stealth.
Logs in and saves session cookies to a JSON file for reuse.

Usage:
    python3 login.py [--target URL] [--cookies COOKIE_FILE]

Defaults:
    --target  https://lcr.churchofjesuschrist.org
    --cookies /tmp/church_cookies.json
"""
import argparse
import asyncio
import json
import subprocess
import sys

from playwright.async_api import async_playwright
from playwright_stealth import Stealth


def get_credential(key):
    return subprocess.check_output(
        f"export PATH=$HOME/.local/bin:$PATH && pass show {key}",
        shell=True, text=True
    ).strip()

def log(msg):
    sys.stdout.write(f"{msg}\n"); sys.stdout.flush()

async def login(target_url="https://lcr.churchofjesuschrist.org", cookie_file="/tmp/church_cookies.json", screenshot_dir="/tmp"):
    username = get_credential("church/username")
    password = get_credential("church/password")
    
    async with async_playwright() as p:
        browser = await p.chromium.launch(
            headless=True,
            executable_path="/usr/bin/google-chrome",
            args=["--no-sandbox", "--disable-blink-features=AutomationControlled", "--disable-dev-shm-usage"]
        )
        context = await browser.new_context(
            viewport={"width": 1920, "height": 1080},
            user_agent="Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        )
        page = await context.new_page()
        await Stealth().apply_stealth_async(page)

        # Navigate to target (will redirect to OAuth login if not authenticated)
        log(f"Navigating to {target_url}...")
        await page.goto(target_url, wait_until="domcontentloaded", timeout=30000)
        await asyncio.sleep(5)

        # Check if we're on the login page
        if "id.churchofjesuschrist.org" in page.url:
            log("On login page — entering credentials...")
            
            # Username
            username_input = page.locator('#username-input, input[name="username"]')
            if await username_input.count() > 0:
                await username_input.first.fill(username)
                log("Filled username")
                await asyncio.sleep(1)

                # Click Next
                submit = page.locator('button[type="submit"]')
                if await submit.count() > 0:
                    await submit.first.click()
                    log("Clicked Next")
                    await asyncio.sleep(5)

                # Password
                pw_input = page.locator('input[type="password"]:visible')
                if await pw_input.count() > 0:
                    await pw_input.first.fill(password)
                    log("Filled password")
                    await asyncio.sleep(1)

                    submit2 = page.locator('button[type="submit"]')
                    if await submit2.count() > 0:
                        await submit2.first.click()
                        log("Submitted password")
                        await asyncio.sleep(10)
                else:
                    log("ERROR: No password field found")
                    await page.screenshot(path=f"{screenshot_dir}/church_login_error.png")
                    await browser.close()
                    return False
            else:
                log("ERROR: No username field found")
                await page.screenshot(path=f"{screenshot_dir}/church_login_error.png")
                await browser.close()
                return False

        # Check if login succeeded
        final_url = page.url
        log(f"Final URL: {final_url}")
        
        if "id.churchofjesuschrist.org" in final_url:
            log("ERROR: Still on login page — authentication may have failed")
            await page.screenshot(path=f"{screenshot_dir}/church_login_failed.png")
            body = (await page.inner_text("body"))[:500]
            log(f"Page: {body}")
            await browser.close()
            return False

        log("Login successful!")
        await page.screenshot(path=f"{screenshot_dir}/church_logged_in.png")

        # Save cookies
        cookies = await context.cookies()
        with open(cookie_file, "w") as f:
            json.dump(cookies, f, indent=2)
        log(f"Saved {len(cookies)} cookies to {cookie_file}")

        # Save storage state (cookies + localStorage) for full session restore
        state_file = cookie_file.replace(".json", "_state.json")
        await context.storage_state(path=state_file)
        log(f"Saved storage state to {state_file}")

        await browser.close()
        return True


async def load_session(cookie_file="/tmp/church_cookies.json"):
    """Create a browser context with saved cookies. Returns (browser, context, page)."""
    state_file = cookie_file.replace(".json", "_state.json")

    playwright = await async_playwright().start()
    browser = await playwright.chromium.launch(
        headless=True,
        executable_path="/usr/bin/google-chrome",
        args=["--no-sandbox", "--disable-blink-features=AutomationControlled", "--disable-dev-shm-usage"]
    )
    context = await browser.new_context(
        viewport={"width": 1920, "height": 1080},
        user_agent="Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        storage_state=state_file,
    )
    page = await context.new_page()
    await Stealth().apply_stealth_async(page)

    original_close = browser.close

    async def close_with_playwright(*args, **kwargs):
        try:
            return await original_close(*args, **kwargs)
        finally:
            await playwright.stop()

    browser.close = close_with_playwright
    return browser, context, page


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Login to Church of Jesus Christ account")
    parser.add_argument("--target", default="https://lcr.churchofjesuschrist.org", help="Target URL (will redirect to login)")
    parser.add_argument("--cookies", default="/tmp/church_cookies.json", help="Cookie file path")
    args = parser.parse_args()
    
    success = asyncio.run(login(target_url=args.target, cookie_file=args.cookies))
    sys.exit(0 if success else 1)
