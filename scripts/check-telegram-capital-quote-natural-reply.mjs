import assert from "node:assert/strict";
import { buildCapitalQuoteNaturalLanguageReplyText } from "../extensions/telegram/src/capital-quote-natural-language.ts";

const replyText = await buildCapitalQuoteNaturalLanguageReplyText({
  text: "A50目前報價",
  repoRoot: process.cwd(),
});
const txfCurrentReplyText = await buildCapitalQuoteNaturalLanguageReplyText({
  text: "台指期當月報價",
  repoRoot: process.cwd(),
});
const txfNextReplyText = await buildCapitalQuoteNaturalLanguageReplyText({
  text: "台指期下個月報價",
  repoRoot: process.cwd(),
});
const crudeReplyText = await buildCapitalQuoteNaturalLanguageReplyText({
  text: "原油期貨報",
  repoRoot: process.cwd(),
});
const brentReplyText = await buildCapitalQuoteNaturalLanguageReplyText({
  text: "布蘭特油報價",
  repoRoot: process.cwd(),
});

assert.equal(typeof replyText, "string");
assert.ok(replyText.length > 0, "natural quote reply must not be empty");
assert.equal(typeof txfCurrentReplyText, "string");
assert.ok(
  txfCurrentReplyText.length > 0,
  "natural TXF current-month quote reply must not be empty",
);
assert.equal(typeof txfNextReplyText, "string");
assert.ok(txfNextReplyText.length > 0, "natural TXF next-month quote reply must not be empty");
assert.equal(typeof crudeReplyText, "string");
assert.ok(crudeReplyText.length > 0, "natural crude quote reply must not be empty");
assert.equal(typeof brentReplyText, "string");
assert.ok(brentReplyText.length > 0, "natural Brent quote reply must not be empty");
assert.match(replyText, /^\[OpenClaw 報價\]/u);
assert.match(replyText, /A50|CN0000|封鎖/u);
assert.match(replyText, /真單=封鎖/u);
assert.match(txfCurrentReplyText, /^\[OpenClaw 報價\]/u);
assert.match(txfCurrentReplyText, /TX06|台指|月份路由=TXF\/current-month/u);
assert.doesNotMatch(txfCurrentReplyText, /月份路由=TXF\/current-month\/TX00/u);
assert.match(txfCurrentReplyText, /真單=封鎖/u);
assert.match(txfNextReplyText, /^\[OpenClaw 報價\]/u);
assert.match(txfNextReplyText, /TX07|台指|月份路由=TXF\/next-month/);
assert.doesNotMatch(txfNextReplyText, /月份路由=TXF\/next-month\/TX00/u);
assert.doesNotMatch(txfNextReplyText, /月份路由=TXF\/next-month\/TX06/u);
assert.match(txfNextReplyText, /真單=封鎖/u);
assert.doesNotMatch(replyText, /@openclaw\/cron-direct/u);
assert.doesNotMatch(replyText, /Repository not found/u);
assert.doesNotMatch(replyText, /package .* could not be found on the npm registry/iu);
assert.match(crudeReplyText, /^\[OpenClaw 報價\]/u);
assert.match(crudeReplyText, /原油|CL0000|封鎖/u);
assert.match(crudeReplyText, /真單=封鎖/u);
assert.doesNotMatch(crudeReplyText, /@openclaw\/cron-direct/u);
assert.doesNotMatch(crudeReplyText, /Repository not found/u);
assert.doesNotMatch(crudeReplyText, /package .* could not be found on the npm registry/iu);
assert.match(brentReplyText, /^\[OpenClaw 報價\]/u);
assert.match(brentReplyText, /布蘭特|BZ0000|封鎖/u);
assert.match(brentReplyText, /真單=封鎖/u);
assert.doesNotMatch(brentReplyText, /@openclaw\/cron-direct/u);
assert.doesNotMatch(brentReplyText, /Repository not found/u);
assert.doesNotMatch(brentReplyText, /package .* could not be found on the npm registry/iu);

if (replyText.includes("狀態=即時")) {
  assert.match(replyText, /本商品=可用/u);
  assert.match(
    replyText,
    /全商品監控=另有(?:stale|session_closed|missing_callback|not_subscribed|zero_or_unusable_price)|全商品監控=全部就緒/u,
  );
  assert.match(replyText, /買價=/u);
  assert.match(replyText, /賣價=/u);
  assert.match(replyText, /成交=/u);
  assert.match(replyText, /延遲=\d+秒/u);
} else {
  assert.match(replyText, /封鎖/u);
  assert.match(replyText, /不可回舊價/u);
}
if (txfCurrentReplyText.includes("狀態=即時")) {
  assert.match(txfCurrentReplyText, /本商品=可用/u);
  assert.match(txfCurrentReplyText, /月份路由=TXF\/current-month/u);
  assert.match(txfCurrentReplyText, /買價=/u);
  assert.match(txfCurrentReplyText, /賣價=/u);
  assert.match(txfCurrentReplyText, /成交=/u);
  assert.match(txfCurrentReplyText, /延遲=\d+秒/u);
} else {
  assert.match(txfCurrentReplyText, /封鎖|SESSION_CLOSED/u);
  assert.match(txfCurrentReplyText, /不可回舊價/u);
}
if (txfNextReplyText.includes("狀態=即時")) {
  assert.match(txfNextReplyText, /本商品=可用/u);
  assert.match(txfNextReplyText, /月份路由=TXF\/next-month/u);
  assert.match(txfNextReplyText, /買價=/u);
  assert.match(txfNextReplyText, /賣價=/u);
  assert.match(txfNextReplyText, /成交=/u);
  assert.match(txfNextReplyText, /延遲=\d+秒/u);
} else {
  assert.match(txfNextReplyText, /封鎖|SESSION_CLOSED/u);
  assert.match(txfNextReplyText, /不可回舊價/u);
}
if (crudeReplyText.includes("狀態=即時")) {
  assert.match(crudeReplyText, /本商品=可用/u);
  assert.match(
    crudeReplyText,
    /全商品監控=另有(?:stale|session_closed|missing_callback|not_subscribed|zero_or_unusable_price)|全商品監控=全部就緒/u,
  );
  assert.match(crudeReplyText, /買價=/u);
  assert.match(crudeReplyText, /賣價=/u);
  assert.match(crudeReplyText, /成交=/u);
  assert.match(crudeReplyText, /延遲=\d+秒/u);
} else {
  assert.match(crudeReplyText, /封鎖/u);
  assert.match(crudeReplyText, /不可回舊價/u);
}
if (brentReplyText.includes("狀態=即時")) {
  assert.match(brentReplyText, /本商品=可用/u);
  assert.match(
    brentReplyText,
    /全商品監控=另有(?:stale|session_closed|missing_callback|not_subscribed|zero_or_unusable_price)|全商品監控=全部就緒/u,
  );
  assert.match(brentReplyText, /買價=/u);
  assert.match(brentReplyText, /賣價=/u);
  assert.match(brentReplyText, /成交=/u);
  assert.match(brentReplyText, /延遲=\d+秒/u);
} else {
  assert.match(brentReplyText, /封鎖/u);
  assert.match(brentReplyText, /不可回舊價/u);
}

process.stdout.write(
  `telegram capital quote natural reply check PASS\n${replyText}\n${txfCurrentReplyText}\n${txfNextReplyText}\n${crudeReplyText}\n${brentReplyText}\n`,
);
