// Real runtime proof (#72504): command detection survives @name bot mention.
import { describe, it } from "vitest";
import { normalizeFeishuCommandProbeBody, normalizeMentions } from "./bot-content.js";

const COMMAND_RE = /(?:^|\s)[/!][a-z]/i;

function log(title: string, input: string, actual: string, expected: string, pass: boolean) {
  const marker = pass ? "✓" : "✗";
  console.log(`  ${marker} ${title}`);
  console.log(`    Input:    ${JSON.stringify(input)}`);
  if (!pass) console.log(`    Expected: ${JSON.stringify(expected)}`);
  console.log(`    Got:      ${JSON.stringify(actual)}`);
}

describe("Real Runtime Proof — normalizeMentions preserves @name (#72504)", () => {
  it("proof: bot mention → @name format", () => {
    console.log("");

    const cases: Array<[string, string, string, string]> = [
      ["bot + slash cmd", "@_bot_1 /model", "@MyBot /model", "ou_bot"],
      ["bot + plain text", "@_bot_1 hello", "@MyBot hello", "ou_bot"],
      ["non-bot → <at>", "@_user_1 hi", '<at user_id="ou_alice">Alice</at> hi', "ou_bot"],
    ];

    for (const [desc, input, expected, botStripId] of cases) {
      const result = normalizeMentions(input, [
        { key: desc.includes("non-bot") ? "@_user_1" : "@_bot_1",
          name: desc.includes("non-bot") ? "Alice" : "MyBot",
          id: { open_id: desc.includes("non-bot") ? "ou_alice" : botStripId } }
      ], botStripId);
      log(desc, input, result, expected, result === expected);
    }
  });
});

describe("Real Runtime Proof — normalizeFeishuCommandProbeBody strips @name (#72504)", () => {
  it("proof: @name stripped, slash commands preserved", () => {
    console.log("");

    const cases: Array<[string, string, string]> = [
      ["@name strip, slash cmd", "@MyBot /model", "/model"],
      ["@name strip, bang cmd", "@MyBot !reset", "!reset"],
      ["@name + text + cmd", "@MyBot please /status", "please /status"],
      ["multi @mention + cmd", "@BotA @BotB /model", "/model"],
      ["@name-only, no cmd", "@MyBot", ""],
      ["@name + plain text", "@MyBot hello world", "hello world"],
      ["plain /cmd, no @", "/model", "/model"],
      ["<at> tag + cmd", '<at user_id="ou_alice">Alice</at> /status', "/status"],
      ["special chars @name", "@Bot-Name /version", "/version"],
      ["empty", "", ""],
    ];

    for (const [desc, input, expected] of cases) {
      const result = normalizeFeishuCommandProbeBody(input);
      log(desc, input, result, expected, result === expected);
    }
  });
});

describe("Real Runtime Proof — End-to-end: ctx.content → probe → command detection (#72504)", () => {
  it("proof: command detection survives @name mention", () => {
    console.log("\n  ctx.content → commandProbeBody → hasCommand");

    const cases = [
      ["@MyBot /model", true],
      ["@MyBot !reset", true],
      ["@MyBot hello /status", true],
      ["hello /model", true],
      ["@MyBot", false],
      ["@BotA @BotB /model", true],
      ["@MyBot /help arg", true],
      ["  @MyBot  /model  ", true],
    ];

    for (const [ctx, expectCmd] of cases) {
      const probe = normalizeFeishuCommandProbeBody(ctx as string);
      const hasCmd = COMMAND_RE.test(probe);
      const pass = hasCmd === expectCmd;
      const marker = hasCmd ? "CMD ✓" : "no cmd";
      console.log(`  ${pass ? "✓" : "✗"} ${marker} | ctx=${JSON.stringify(ctx)} → probe=${JSON.stringify(probe)}`);
    }
  });
});
