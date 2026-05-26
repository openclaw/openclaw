// docs/dashboard_comments/comment_model.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadModel() {
  const source = readFileSync(join(__dirname, "comment_model.js"), "utf8");
  const sandbox = { window: {} };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: "comment_model.js" });
  return sandbox.window.DashboardCommentModel;
}

test("anchor id is stable and readable", () => {
  const model = loadModel();
  const anchor = {
    pageKey: "moclaw_operating_dashboard",
    pageVersion: "v1",
    sheetKey: "user_acquisition",
    sheetTitle: "用户获取",
    sectionKey: "paid_media",
    sectionTitle: "投放",
    rowKey: "ad_spend",
    rowLabel: "广告花费",
    columnKey: "today_2026_05_22",
    columnLabel: "当日 05-22",
    anchorType: "cell"
  };

  assert.equal(
    model.anchorId(anchor),
    "moclaw_operating_dashboard:v1:user_acquisition:paid_media:ad_spend:today_2026_05_22:cell"
  );
  assert.equal(model.anchorLabel(anchor), "用户获取 / 投放 / 广告花费 / 当日 05-22");
});

test("anchor validation rejects missing semantic keys", () => {
  const model = loadModel();
  assert.equal(model.isValidAnchor({ anchorType: "cell" }), false);
  assert.equal(model.isValidAnchor({
    pageKey: "moclaw_operating_dashboard",
    pageVersion: "v1",
    sheetKey: "user_acquisition",
    sectionKey: "paid_media",
    rowKey: "ad_spend",
    columnKey: "today_2026_05_22",
    anchorType: "cell"
  }), true);
});

test("cell mention tokens round trip", () => {
  const model = loadModel();
  const anchor = {
    pageKey: "moclaw_operating_dashboard",
    pageVersion: "v1",
    sheetKey: "user_acquisition",
    sheetTitle: "用户获取",
    sectionKey: "paid_media",
    sectionTitle: "投放",
    rowKey: "ad_spend",
    rowLabel: "广告花费",
    columnKey: "today_2026_05_22",
    columnLabel: "当日 05-22",
    anchorType: "cell"
  };

  const token = model.makeMentionToken(anchor);
  assert.equal(
    token,
    "@{cell:moclaw_operating_dashboard:v1:user_acquisition:paid_media:ad_spend:today_2026_05_22:cell|用户获取 / 投放 / 广告花费 / 当日 05-22}"
  );
  assert.deepEqual(model.parseMentionToken(token), {
    id: "moclaw_operating_dashboard:v1:user_acquisition:paid_media:ad_spend:today_2026_05_22:cell",
    label: "用户获取 / 投放 / 广告花费 / 当日 05-22"
  });
});

test("row mention token uses row type", () => {
  const model = loadModel();
  const anchor = {
    pageKey: "moclaw_operating_dashboard",
    pageVersion: "v1",
    sheetKey: "user_acquisition",
    sheetTitle: "用户获取",
    sectionKey: "paid_media",
    sectionTitle: "投放",
    rowKey: "ad_spend",
    rowLabel: "广告花费",
    anchorType: "row"
  };

  const token = model.makeMentionToken(anchor);
  assert.equal(
    token,
    "@{row:moclaw_operating_dashboard:v1:user_acquisition:paid_media:ad_spend:_:row|用户获取 / 投放 / 广告花费}"
  );
  assert.deepEqual(model.parseMentionToken(token), {
    id: "moclaw_operating_dashboard:v1:user_acquisition:paid_media:ad_spend:_:row",
    label: "用户获取 / 投放 / 广告花费"
  });
});

test("mention token label with newline round trips", () => {
  const model = loadModel();
  const anchor = {
    pageKey: "moclaw_operating_dashboard",
    pageVersion: "v1",
    sheetKey: "user_acquisition",
    sheetTitle: "用户获取",
    sectionKey: "paid_media",
    sectionTitle: "投放",
    rowKey: "ad_spend",
    rowLabel: "广告花费\n包含 | 和 }",
    anchorType: "row"
  };

  const token = model.makeMentionToken(anchor);
  assert.equal(
    token,
    "@{row:moclaw_operating_dashboard:v1:user_acquisition:paid_media:ad_spend:_:row|%E7%94%A8%E6%88%B7%E8%8E%B7%E5%8F%96%20%2F%20%E6%8A%95%E6%94%BE%20%2F%20%E5%B9%BF%E5%91%8A%E8%8A%B1%E8%B4%B9%0A%E5%8C%85%E5%90%AB%20%7C%20%E5%92%8C%20%7D}"
  );
  assert.deepEqual(model.parseMentionToken(token), {
    id: "moclaw_operating_dashboard:v1:user_acquisition:paid_media:ad_spend:_:row",
    label: "用户获取 / 投放 / 广告花费\n包含 | 和 }"
  });
});
