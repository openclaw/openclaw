#!/usr/bin/env -S node --import tsx
import { chromium } from "playwright-core";
import path from "node:path";
import process from "node:process";
import { createInterface } from "node:readline/promises";

type Args = {
  out: string;
  url: string;
  channel: string;
};

function parseArgs(argv: string[]): Args {
  const args: Args = {
    out: "google-state.json",
    url: "https://mail.google.com/",
    channel: "chrome",
  };

  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out") {
      const v = argv[i + 1];
      if (!v) throw new Error("Missing value for --out");
      args.out = v;
      i++;
      continue;
    }
    if (a === "--url") {
      const v = argv[i + 1];
      if (!v) throw new Error("Missing value for --url");
      args.url = v;
      i++;
      continue;
    }
    if (a === "--channel") {
      const v = argv[i + 1];
      if (!v) throw new Error("Missing value for --channel");
      args.channel = v;
      i++;
      continue;
    }
    if (a === "--help" || a === "-h") {
      // eslint-disable-next-line no-console
      console.log(
        [
          "Usage: node --import tsx scripts/login-google.ts [options]",
          "",
          "Options:",
          "  --out <path>      Output storageState JSON (default: google-state.json)",
          "  --url <url>       Start URL (default: https://mail.google.com/)",
          "  --channel <name>  Browser channel: chrome|msedge|brave (default: chrome)",
        ].join("\n"),
      );
      process.exit(0);
    }

    throw new Error(`Unknown arg: ${a}`);
  }

  return args;
}

async function main() {
  const args = parseArgs(process.argv);

  const outPath = path.resolve(args.out);

  console.log(`Opening a visible browser for manual login: ${args.url}`);
  console.log("👉 Log in manually (including 2FA / confirmations).");
  console.log("👉 Make sure you end up fully logged in (e.g. Gmail inbox loads).");
  console.log("👉 Then return here and press Enter to save the session.");
  console.log("");

  let browser: Awaited<ReturnType<typeof chromium.launch>>;
  try {
    browser = await chromium.launch({
      headless: false,
      channel: args.channel,
    });
  } catch (err) {
    const msg = String((err as Error | undefined)?.message ?? err);
    console.error(msg);
    console.error("");
    console.error("If Playwright can't find your browser, try one of these:");
    console.error('- Install Google Chrome, then keep `--channel chrome` (default).');
    console.error("- Or use Microsoft Edge: `--channel msedge`.");
    console.error("- Or pass a different start URL via `--url`.");
    process.exit(1);
  }

  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(args.url, { waitUntil: "domcontentloaded" });

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  await rl.question("Press Enter when you are fully logged in…");
  rl.close();

  await context.storageState({ path: outPath });

  console.log(`✅ Saved storageState: ${outPath}`);
  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
