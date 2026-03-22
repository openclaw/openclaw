import Kernel from "@onkernel/sdk";
import { chromium } from "playwright-core";

type Action = "doctor" | "smoke-open" | "open-emirates";

interface ParsedArgs {
  action: Action;
  url?: string;
}

function usage(): never {
  console.error(
    [
      "Usage:",
      "  node --import tsx scripts/repro/kernel-browser-smoke.ts doctor",
      "  node --import tsx scripts/repro/kernel-browser-smoke.ts smoke-open <url>",
      "  node --import tsx scripts/repro/kernel-browser-smoke.ts open-emirates",
      "",
      "Environment:",
      "  KERNEL_API_KEY           Required for network actions",
      "  KERNEL_HEADLESS=1        Optional; defaults to headed mode",
      "  KERNEL_STEALTH=0         Optional; defaults to stealth on",
      "  KERNEL_TIMEOUT_SECONDS   Optional; defaults to 900",
      "  KERNEL_KEEP_BROWSER=1    Optional; keep the remote session alive for manual inspection",
    ].join("\n"),
  );
  process.exit(1);
}

function parseArgs(argv: string[]): ParsedArgs {
  const [, , action, maybeUrl] = argv;
  if (action === "doctor") {
    return { action };
  }
  if (action === "smoke-open") {
    if (!maybeUrl) {
      usage();
    }
    return { action, url: maybeUrl };
  }
  if (action === "open-emirates") {
    return { action, url: "https://www.emirates.com/english/" };
  }
  usage();
}

function boolFromEnv(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  if (!value) {
    return fallback;
  }
  return !["0", "false", "no", "off"].includes(value.toLowerCase());
}

async function main() {
  const { action, url } = parseArgs(process.argv);

  if (action === "doctor") {
    console.log(
      JSON.stringify(
        {
          hasKernelApiKey: Boolean(process.env.KERNEL_API_KEY),
          headless: boolFromEnv("KERNEL_HEADLESS", false),
          stealth: boolFromEnv("KERNEL_STEALTH", true),
          timeoutSeconds: Number(process.env.KERNEL_TIMEOUT_SECONDS ?? "900"),
          keepBrowser: boolFromEnv("KERNEL_KEEP_BROWSER", false),
        },
        null,
        2,
      ),
    );
    return;
  }

  const apiKey = process.env.KERNEL_API_KEY;
  if (!apiKey) {
    throw new Error("KERNEL_API_KEY is missing");
  }

  const client = new Kernel({ apiKey });
  const headless = boolFromEnv("KERNEL_HEADLESS", false);
  const stealth = boolFromEnv("KERNEL_STEALTH", true);
  const timeoutSeconds = Number(process.env.KERNEL_TIMEOUT_SECONDS ?? "900");
  const keepBrowser = boolFromEnv("KERNEL_KEEP_BROWSER", false);

  // Keep the browser config deliberately small. The goal here is one clean
  // remote-CDP truth source, not a giant matrix of optional flags.
  const browser = await client.browsers.create({
    headless,
    stealth,
    timeout_seconds: timeoutSeconds,
  });

  console.log(`session_id=${browser.session_id}`);
  console.log(`cdp_ws_url=${browser.cdp_ws_url}`);
  if (browser.browser_live_view_url) {
    console.log(`live_view=${browser.browser_live_view_url}`);
  }

  let cleanupNeeded = !keepBrowser;
  try {
    const remoteBrowser = await chromium.connectOverCDP(browser.cdp_ws_url);

    // Reuse the default context/page when present. Kernel already gives us a
    // live browser session, so creating extra state by default just makes
    // failures harder to reason about.
    const context = remoteBrowser.contexts()[0] ?? (await remoteBrowser.newContext());
    const page = context.pages()[0] ?? (await context.newPage());

    await page.goto(url!, { waitUntil: "domcontentloaded", timeout: 60_000 });
    console.log(`final_url=${page.url()}`);
    console.log(`title=${await page.title()}`);

    await remoteBrowser.close();
  } catch (error) {
    cleanupNeeded = false;
    throw error;
  } finally {
    if (cleanupNeeded) {
      await client.browsers.deleteByID(browser.session_id).catch((error) => {
        console.error(`cleanup_failed=${String(error)}`);
      });
    } else {
      console.error(
        `browser_left_running=session:${browser.session_id} keepBrowser=${keepBrowser}`,
      );
    }
  }
}

await main();
