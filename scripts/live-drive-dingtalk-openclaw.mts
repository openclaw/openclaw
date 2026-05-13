#!/usr/bin/env node --import tsx
// Live driver: 直接调 openclaw 主仓 extensions/dingtalk-connector 的
// dingtalkOnboardingAdapter.configure，让用户扫码，成功后写入
// ~/.openclaw/openclaw.json，并触发 afterConfigWritten hook。
//
// 用法：pnpm exec node --import tsx scripts/live-drive-dingtalk-openclaw.mts

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { dingtalkOnboardingAdapter } from "../extensions/dingtalk-connector/src/onboarding.ts";

const CFG_PATH = path.join(os.homedir(), ".openclaw", "openclaw.json");

const prompter: any = {
  async confirm({ message, initialValue }: any) {
    const v = initialValue ?? true;
    console.log(`[prompter.confirm] ${message} -> ${v}`);
    return v;
  },
  async text({ message, initialValue, placeholder }: any) {
    const v = initialValue ?? placeholder ?? "";
    console.log(`[prompter.text] ${message} -> "${v}"`);
    return v;
  },
  async select({ message, options, initialValue }: any) {
    const v =
      initialValue ??
      options?.[0]?.value ??
      options?.[0]?.label ??
      null;
    console.log(`[prompter.select] ${message} -> ${JSON.stringify(v)}`);
    return v;
  },
  async multiselect({ message, initialValues }: any) {
    console.log(`[prompter.multiselect] ${message} -> []`);
    return initialValues ?? [];
  },
  async password({ message, initialValue }: any) {
    console.log(`[prompter.password] ${message} -> (hidden)`);
    return initialValue ?? "";
  },
  async note(body: string, title?: string) {
    if (title) console.log(`\n── ${title} ──`);
    console.log(body);
    if (title) console.log("─".repeat(Math.max(6, title.length + 6)));
  },
};

const runtime = {
  log: (...a: unknown[]) => console.log("[runtime.log]", ...a),
  error: (...a: unknown[]) => console.error("[runtime.error]", ...a),
  exit: (_c: number) => {},
};

async function main() {
  const raw = await fs.readFile(CFG_PATH, "utf8");
  const previousCfg = JSON.parse(raw);

  console.log("[driver] step 1: invoke dingtalkOnboardingAdapter.configure ...");
  const ctx = {
    cfg: previousCfg,
    runtime,
    prompter,
    options: {},
    accountOverrides: {},
    shouldPromptAccountIds: false,
    forceAllowFrom: false,
  } as any;

  const result = await dingtalkOnboardingAdapter.configure(ctx);
  const nextCfg = result.cfg;
  const accountId = result.accountId ?? "__default__";
  console.log("\n[driver] step 2: configure returned accountId =", accountId);
  console.log(
    "[driver] dingtalk-connector block:",
    JSON.stringify(nextCfg.channels?.["dingtalk-connector"], null, 2),
  );

  console.log("[driver] step 3: backup + write cfg to", CFG_PATH);
  await fs.copyFile(CFG_PATH, CFG_PATH + ".pre-live-drive.bak");
  await fs.writeFile(CFG_PATH, JSON.stringify(nextCfg, null, 2) + "\n", "utf8");

  if (dingtalkOnboardingAdapter.afterConfigWritten) {
    console.log("[driver] step 4: invoke afterConfigWritten hook");
    await dingtalkOnboardingAdapter.afterConfigWritten({
      previousCfg,
      cfg: nextCfg,
      accountId,
      runtime,
    } as any);
  }

  console.log("\n🎉 [driver] DONE — cfg written. You may now start gateway and test.");
}

main().catch((e) => {
  console.error("[driver] FAILED:", e);
  process.exit(1);
});
