#!/usr/bin/env node
/**
 * ClaWorks 商务能力闭环测试（enterprise-commercial pack）
 *
 * 测试场景（全部进程内，无需 Gateway 启动）：
 *   1. KB 文件夹批量入库：写临时文件 → ingest_kb_text action → search_kb 验证
 *   2. 报价单生成：create_customer + create_product → quote.generate_requested 事件 → quote_generate Playbook
 *   3. 投标文件生成：bid.generate_requested 事件 → bid_document_generate Playbook
 *   4. IM 商务意图路由：classify_im 新增意图 → quote_request / bid_request / kb_ingest
 *
 * Usage:
 *   node --import tsx scripts/claworks-commercial-biz-test.mjs
 */
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const packsDir = process.env.CLAWORKS_PACKS_DIR?.trim() || path.join(root, "..", "claworks-packs");
process.env.CLAWORKS_PRODUCT = "1";

let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (!cond) {
    console.error(`  ✗ FAIL: ${msg}`);
    failed++;
    return false;
  }
  console.log(`  ✓ ${msg}`);
  passed++;
  return true;
}

function section(name) {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`  ${name}`);
  console.log("=".repeat(60));
}

async function main() {
  const { createClaworksRuntime, startClaworksRuntime, stopClaworksRuntime } =
    await import("../packages/claworks-runtime/src/index.ts");

  const stateDir = mkdtempSync(path.join(tmpdir(), "claworks-commercial-test-"));
  const dbPath = path.join(stateDir, "robot.db");

  // 准备临时知识库文件夹
  const kbDir = path.join(stateDir, "kb-docs");
  mkdirSync(kbDir);
  writeFileSync(
    path.join(kbDir, "company-profile.txt"),
    "公司简介：某科技有限公司成立于2015年，专注于工业互联网和智能制造领域，已获得ISO9001质量认证。",
  );
  writeFileSync(
    path.join(kbDir, "case-studies.md"),
    "# 典型案例\n\n## 某石化炼厂数字孪生项目\n实施周期6个月，节能降耗12%，故障响应时间缩短40%。\n\n## 某汽车零部件企业MES系统\n覆盖8条产线，生产效率提升18%。",
  );
  writeFileSync(
    path.join(kbDir, "product-list.yaml"),
    "products:\n  - name: 工业数字孪生平台\n    price: 200000\n  - name: 智能运维系统\n    price: 80000",
  );

  const llmResponses = {
    quote: JSON.stringify({
      summary: "基于客户需求，推荐工业数字孪生平台+智能运维系统套餐",
      line_items: [
        { name: "工业数字孪生平台", qty: 1, unit_price: 200000, amount: 200000 },
        { name: "智能运维系统", qty: 1, unit_price: 80000, amount: 80000 },
        { name: "实施服务费", qty: 1, unit_price: 50000, amount: 50000 },
      ],
      total_amount: 330000,
      discount_rate: 0.05,
      final_amount: 313500,
      validity_days: 30,
      notes: "含1年免费维保，可分期付款",
    }),
    bid: "# 投标文件\n\n## 公司简介\n某科技有限公司，专注工业互联网。\n\n## 技术方案\n数字孪生+AI预测性维护整体解决方案。\n\n## 实施计划\n共6个月，分三阶段交付。\n\n## 商务报价\n总报价：330,000元（含税）。",
    classify: JSON.stringify({
      intent: "quote_request",
      confidence: 0.92,
      extracted: {
        customer_name: "华能集团",
        requirements: "需要工业数字孪生解决方案报价",
      },
    }),
  };

  let llmCallCount = 0;

  const runtime = await createClaworksRuntime(
    {
      robot: { name: "commercial-test-robot", role: "monolith", port: 18_900, host: "127.0.0.1" },
      data: { database_url: `sqlite://${dbPath}` },
      packs: {
        paths: [packsDir],
        installed: ["base", "process-industry", "enterprise-general", "enterprise-commercial"],
      },
    },
    {
      logger: (m) => {
        if (process.env.VERBOSE) console.log("  [log]", m);
      },
      llmComplete: async ({ prompt }) => {
        llmCallCount++;
        const p = prompt.toLowerCase();
        if (p.includes("报价") || p.includes("quote") || p.includes("价格")) {
          return { text: llmResponses.quote };
        }
        if (p.includes("投标") || p.includes("bid") || p.includes("招标")) {
          return { text: llmResponses.bid };
        }
        if (p.includes("意图") || p.includes("intent")) {
          return { text: llmResponses.classify };
        }
        return { text: '{"intent":"none","confidence":0.1,"extracted":{}}' };
      },
      notify: async ({ message, channels }) => {
        if (process.env.VERBOSE) {
          console.log(`  [notify] channels=${channels?.join(",")} msg=${message.slice(0, 80)}...`);
        }
      },
    },
  );

  await startClaworksRuntime(runtime);
  const playbookIds = new Set(runtime.playbookEngine.list().map((p) => p.id));
  const loadedPacks = runtime.loadedPacks.map((p) => p.manifest.id);
  console.log(`\nLoaded packs: ${loadedPacks.join(", ")}`);
  console.log(`Loaded playbooks: ${runtime.playbookEngine.list().length}`);

  // ─────────────────────────────────────────────────────────
  // 1. KB 文件夹批量入库
  // ─────────────────────────────────────────────────────────
  section("1. KB 文件夹批量入库");

  assert(loadedPacks.includes("enterprise-commercial"), "enterprise-commercial pack 已加载");
  assert(playbookIds.has("kb_folder_ingest"), "kb_folder_ingest Playbook 已加载");

  // 通过事件触发 kb_folder_ingest Playbook
  const [kbMatch] = await runtime.kernel.publish("kb.folder_ingest_requested", "test", {
    folder_path: kbDir,
    namespace: "company",
  });
  assert(!!kbMatch, "kb.folder_ingest_requested 事件命中 kb_folder_ingest Playbook");

  // 验证 KB 搜索（等待入库完成）
  await new Promise((r) => setTimeout(r, 100));
  const kbResults = await runtime.kb.search("公司简介 质量认证", {
    namespace: "company",
    limit: 5,
  });
  assert(kbResults.length > 0, `KB 文件夹入库后可检索到内容（${kbResults.length} 条）`);

  // 也测试单条文本 action
  const ingestResult = await runtime.objectStore.executeAction(
    "_virtual",
    "_kb",
    "ingest_kb_text",
    {
      text: "产品：工业数字孪生平台 v3.0，支持OPC-UA协议，实时数据采集，AI预测性维护。",
      namespace: "products",
      source: "product-manual",
    },
    {
      objectStore: runtime.objectStore,
      kb: runtime.kb,
      publishEvent: runtime.kernel.publish.bind(runtime.kernel),
    },
  );
  assert(
    ingestResult?.status === "ok" || ingestResult?.id,
    "ingest_kb_text action 单条文本入库成功",
  );

  // ─────────────────────────────────────────────────────────
  // 2. 报价单生成闭环
  // ─────────────────────────────────────────────────────────
  section("2. 报价单生成闭环");

  assert(playbookIds.has("quote_generate"), "quote_generate Playbook 已加载");
  assert(playbookIds.has("quote_created_notify"), "quote_created_notify Playbook 已加载");

  // 创建客户档案
  const customer = await runtime.objectStore.create("Customer", {
    name: "华能集团",
    industry: "能源",
    contact_name: "李总",
    contact_email: "li@huaneng.com",
    contact_phone: "13800138000",
  });
  assert(!!customer?.id, `Customer 对象创建成功 (id=${customer?.id})`);

  // 创建产品
  const product = await runtime.objectStore.create("Product", {
    name: "工业数字孪生平台",
    category: "软件平台",
    unit_price: 200000,
    currency: "CNY",
    description: "实时数字孪生+AI预测性维护，支持OPC-UA协议",
  });
  assert(!!product?.id, `Product 对象创建成功 (id=${product?.id})`);

  // 触发报价生成
  const [quoteMatch] = await runtime.kernel.publish("quote.create_requested", "test", {
    customer_id: customer.id,
    customer_name: "华能集团",
    requirements: "需要工业数字孪生解决方案，含数据采集、实时监控、AI预测性维护模块",
    channel_id: "feishu",
    kb_namespace: "company",
  });
  assert(!!quoteMatch, "quote.generate_requested 事件命中 quote_generate Playbook");

  // 等待 Playbook 完成（含 LLM 调用）
  await new Promise((r) => setTimeout(r, 200));

  // 验证报价单已创建
  const { items: quotes } = await runtime.objectStore.query("Quote", { limit: 10 });
  assert(quotes.length >= 1, `Quote 对象已写入 ObjectStore（${quotes.length} 个）`);

  if (quotes.length > 0) {
    const q = quotes[0];
    assert(q.customer_id === customer.id, "Quote 关联正确的 Customer");
    assert(
      typeof q.quote_no === "string" && q.quote_no.startsWith("QT-"),
      `Quote 编号格式正确 (${q.quote_no})`,
    );
  }

  // ─────────────────────────────────────────────────────────
  // 3. 投标文件生成闭环
  // ─────────────────────────────────────────────────────────
  section("3. 投标文件生成闭环");

  assert(playbookIds.has("bid_document_generate"), "bid_document_generate Playbook 已加载");
  assert(playbookIds.has("bid_project_created"), "bid_project_created Playbook 已加载");

  const [bidMatch] = await runtime.kernel.publish("bid.generate_requested", "test", {
    project_title: "华能集团工业数字孪生建设项目",
    customer_name: "华能集团",
    customer_id: customer.id,
    project_type: "工业数字孪生",
    doc_type: "technical_proposal",
    budget_amount: 500000,
    bid_deadline: "2026-06-30",
    requirements: "建设数字孪生平台，覆盖主要生产装置，实现实时监控和预测性维护。",
    our_advantage: "在能源行业有多个成功案例，团队具备OPC-UA和AI算法开发能力。",
    kb_namespace: "company",
    channel_id: "feishu",
  });
  assert(!!bidMatch, "bid.generate_requested 事件命中 bid_document_generate Playbook");

  await new Promise((r) => setTimeout(r, 300));

  // 验证 BidProject 已创建
  const { items: bidProjects } = await runtime.objectStore.query("BidProject", { limit: 10 });
  assert(bidProjects.length >= 1, `BidProject 对象已写入 ObjectStore（${bidProjects.length} 个）`);

  // 验证 BidDocument 已创建
  const { items: bidDocs } = await runtime.objectStore.query("BidDocument", { limit: 10 });
  assert(bidDocs.length >= 1, `BidDocument 对象已写入 ObjectStore（${bidDocs.length} 个）`);

  if (bidDocs.length > 0) {
    const doc = bidDocs[0];
    assert(doc.doc_type === "technical_proposal", `BidDocument 类型正确 (${doc.doc_type})`);
    assert(typeof doc.content === "string" && doc.content.length > 50, "BidDocument 内容已生成");
  }

  // ─────────────────────────────────────────────────────────
  // 4. IM 商务意图路由
  // ─────────────────────────────────────────────────────────
  section("4. IM 商务意图路由");

  const { bridgeImMessage } = await import("../packages/claworks-runtime/src/index.ts");
  const imResult = await bridgeImMessage(runtime, {
    channel_id: "feishu",
    user_id: "sales-001",
    tenant_id: "acme",
    message: "我需要给华能集团做一个工业数字孪生解决方案的报价单",
  });
  assert(imResult?.action === "intent_routed", `IM 商务消息路由成功 (action=${imResult?.action})`);
  assert(llmCallCount > 0, `LLM 被调用（共 ${llmCallCount} 次）`);

  // ─────────────────────────────────────────────────────────
  // 5. ObjectStore 对象汇总验证
  // ─────────────────────────────────────────────────────────
  section("5. ObjectStore 商务对象汇总");

  const { items: customers } = await runtime.objectStore.query("Customer", { limit: 10 });
  const { items: products } = await runtime.objectStore.query("Product", { limit: 10 });
  const { items: quotesAll } = await runtime.objectStore.query("Quote", { limit: 10 });
  const { items: bpAll } = await runtime.objectStore.query("BidProject", { limit: 10 });
  const { items: bdAll } = await runtime.objectStore.query("BidDocument", { limit: 10 });

  assert(customers.length >= 1, `Customer 对象：${customers.length} 个`);
  assert(products.length >= 1, `Product 对象：${products.length} 个`);
  assert(quotesAll.length >= 1, `Quote 对象：${quotesAll.length} 个`);
  assert(bpAll.length >= 1, `BidProject 对象：${bpAll.length} 个`);
  assert(bdAll.length >= 1, `BidDocument 对象：${bdAll.length} 个`);

  // ─────────────────────────────────────────────────────────
  // 结束
  // ─────────────────────────────────────────────────────────
  await stopClaworksRuntime(runtime);

  console.log(`\n${"=".repeat(60)}`);
  console.log(`  测试结果：${passed} 通过 / ${failed} 失败`);
  if (failed === 0) {
    console.log("  ✅ ALL COMMERCIAL BIZ TESTS PASSED");
  } else {
    console.log("  ❌ SOME TESTS FAILED");
  }
  console.log("=".repeat(60));

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(2);
});
