#!/usr/bin/env -S npx tsx
/**
 * Smoke test for xiaohongshu plugin.
 * Usage:
 *   XHS_COOKIE="a1=xxx;web_session=xxx" npx tsx extensions/xiaohongshu/test-smoke.ts
 *
 * If no cookie is provided, only the signature module is tested.
 */

import { XhsClient } from "./src/client.js";
import { getXsXt } from "./src/signature.js";

const pass = (name: string) => console.log(`  ✅ ${name}`);
const fail = (name: string, err: unknown) =>
  console.error(`  ❌ ${name}:`, err instanceof Error ? err.message : err);

async function main() {
  let ok = 0;
  let failed = 0;

  console.log("\n--- Signature Module ---");
  try {
    const { xs, xt } = getXsXt(
      "/api/sns/web/v1/homefeed",
      { test: 1 },
      "a1=dummy;web_session=dummy",
    );
    if (xs && xt) {
      pass(`getXsXt => X-s=${xs.substring(0, 24)}… X-t=${xt}`);
      ok++;
    } else throw new Error("empty result");
  } catch (err) {
    fail("getXsXt", err);
    failed++;
  }

  console.log("\n--- XhsClient initialization ---");
  const cookie = process.env.XHS_COOKIE;
  if (!cookie) {
    console.log("\n⚠️  No XHS_COOKIE env var set — skipping live API tests.\n");
    console.log(`Result: ${ok} passed, ${failed} failed (signature-only mode)\n`);
    process.exit(failed > 0 ? 1 : 0);
  }

  const client = new XhsClient(cookie);
  // Wait a moment for TLS bridge to initialize
  await new Promise((r) => setTimeout(r, 2000));

  console.log(`  TLS bridge active: ${client.hasTlsBridge}`);
  if (!client.hasTlsBridge) {
    console.log("  ⚠️  curl_cffi not available, using native fetch (some endpoints may fail)");
  }

  console.log("\n--- Live API: check cookie ---");
  try {
    const res = await client.request<{ nickname: string }>("/api/sns/web/v2/user/me");
    if (res.success) {
      pass(`Cookie valid, user: ${JSON.stringify(res.data?.nickname ?? res.data)}`);
      ok++;
    } else {
      fail("check cookie", `API returned: ${res.msg ?? JSON.stringify(res)}`);
      failed++;
    }
  } catch (err) {
    fail("check cookie", err);
    failed++;
  }

  console.log("\n--- Live API: search notes ---");
  try {
    const data = {
      keyword: "美食",
      page: 1,
      page_size: 5,
      search_id: client.searchId(),
      sort: "general",
      note_type: 0,
      ext_flags: [],
      geo: "",
      image_formats: JSON.stringify(["jpg", "webp", "avif"]),
    };
    const res = await client.request<{
      items: Array<{ id: string; note_card: { display_title: string } }>;
    }>("/api/sns/web/v1/search/notes", { method: "POST", data });
    if (res.data?.items?.length) {
      const titles = res.data.items
        .slice(0, 3)
        .map((i) => i.note_card?.display_title)
        .filter(Boolean);
      pass(`Search returned ${res.data.items.length} results: ${titles.join(", ")}`);
      ok++;
    } else {
      fail("search notes", `No items returned (may need fresh cookie with search history)`);
      failed++;
    }
  } catch (err) {
    fail("search notes", err);
    failed++;
  }

  console.log("\n--- Live API: home feed ---");
  try {
    const data = {
      category: "homefeed_recommend",
      cursor_score: "",
      image_formats: JSON.stringify(["jpg", "webp", "avif"]),
      need_filter_image: false,
      need_num: 8,
      num: 5,
      note_index: 0,
      refresh_type: 1,
      search_key: "",
      unread_begin_note_id: "",
      unread_end_note_id: "",
      unread_note_count: 0,
    };
    const res = await client.request<{
      items: Array<{ id: string; note_card: { display_title: string } }>;
    }>("/api/sns/web/v1/homefeed", { method: "POST", data, signed: true });
    if (res.data?.items?.length) {
      const titles = res.data.items
        .slice(0, 3)
        .map((i) => i.note_card?.display_title)
        .filter(Boolean);
      pass(`Home feed returned ${res.data.items.length} items: ${titles.join(", ")}`);
      ok++;
    } else {
      fail("home feed", `No items (code: ${res.code})`);
      failed++;
    }
  } catch (err) {
    fail("home feed", err);
    failed++;
  }

  await client.close();

  console.log(`\nResult: ${ok} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
