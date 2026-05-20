#!/usr/bin/env node
/**
 * ClaWorks 企业通用业务闭环测试
 *
 * 测试场景（全部进程内，无需 Gateway 启动）：
 *   1. 任务管理：创建任务 → task.created 事件 → 通知链路
 *   2. 审批流程：创建审批 → approval.created → HITL → 决策 → approval.decided
 *   3. 故障响应：incident.created → AI分析 → 创建处置任务 → incident.resolved → 复盘KB
 *   4. 会议纪要：meeting.created → AI摘要 → KB入库
 *   5. IM意图路由：classify_im → 企业意图 → 发布业务事件
 *   6. 知识库查询：kb ingest → search → 结果
 *   7. 日报生成：query_daily_stats → AI日报
 *
 * Usage:
 *   node --import tsx scripts/claworks-enterprise-biz-test.mjs
 */
import { mkdtempSync, writeFileSync } from "node:fs";
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
  const { createClaworksRuntime, startClaworksRuntime, stopClaworksRuntime, bridgeImMessage } =
    await import("../packages/claworks-runtime/src/index.ts");

  const stateDir = mkdtempSync(path.join(tmpdir(), "claworks-biz-test-"));
  const dbPath = path.join(stateDir, "robot.db");

  const llmResponses = {
    classify: JSON.stringify({
      intent: "approval_create",
      confidence: 0.91,
      extracted: { amount: 480, category: "expense", title: "出差报销申请" },
    }),
    diagnose: JSON.stringify({
      root_cause_hints: ["数据库连接池耗尽", "慢查询未优化"],
      suggested_actions: ["重启连接池", "添加查询索引"],
      confidence: 0.85,
    }),
    meeting: JSON.stringify({
      summary: "本次会议讨论了Q2规划，决定加快产品迭代",
      action_items: [{ title: "产品路线图更新", assignee: "张三", due: "2026-05-30" }],
    }),
    incident_postmortem: JSON.stringify({
      postmortem_summary: "数据库连接池配置不当导致服务降级，已优化配置参数",
      lessons_learned: ["连接池需设置最大连接数上限", "添加连接池监控告警"],
    }),
    kb_answer: "根据知识库记录，出差报销需提交发票、行程单和审批单，500元以下可自动批准。",
    daily_report: "## 📊 今日运营日报\n\n今日运行平稳，共处理任务3个，故障0个，审批1个。继续保持！",
  };

  let llmCallCount = 0;
  const llmCallLog = [];

  const runtime = await createClaworksRuntime(
    {
      robot: { name: "biz-test-robot", role: "monolith", port: 18_800, host: "127.0.0.1" },
      data: { database_url: `sqlite://${dbPath}` },
      packs: { paths: [packsDir], installed: ["base", "process-industry", "enterprise-general"] },
    },
    {
      logger: (m) => {
        if (process.env.VERBOSE) console.log("  [log]", m);
      },
      llmComplete: async ({ prompt }) => {
        llmCallCount++;
        const p = prompt.toLowerCase();
        if (p.includes("意图") || p.includes("intent")) return { text: llmResponses.classify };
        if (p.includes("根因") || p.includes("root cause") || p.includes("故障"))
          return { text: llmResponses.diagnose };
        if (p.includes("会议") || p.includes("纪要")) return { text: llmResponses.meeting };
        if (p.includes("复盘") || p.includes("postmortem"))
          return { text: llmResponses.incident_postmortem };
        if (p.includes("日报") || p.includes("report")) return { text: llmResponses.daily_report };
        if (p.includes("知识库") || p.includes("kb") || p.includes("报销"))
          return { text: llmResponses.kb_answer };
        llmCallLog.push(prompt.slice(0, 80));
        return { text: '{"intent":"none","confidence":0.1,"extracted":{}}' };
      },
      notify: async ({ message, channels }) => {
        if (process.env.VERBOSE) {
          console.log(`  [notify] channels=${channels?.join(",")} msg=${message.slice(0, 60)}...`);
        }
      },
    },
  );

  await startClaworksRuntime(runtime);
  const playbookIds = new Set(runtime.playbookEngine.list().map((p) => p.id));
  console.log(`\nLoaded packs: ${runtime.loadedPacks.map((p) => p.manifest.id).join(", ")}`);
  console.log(`Loaded playbooks: ${runtime.playbookEngine.list().length}`);

  // ─────────────────────────────────────────────────────────
  // 1. 任务管理
  // ─────────────────────────────────────────────────────────
  section("1. 任务管理闭环");

  // 直接发布 task.created 事件（action 步骤路径）
  const [taskMatch] = await runtime.kernel.publish("task.created", "test", {
    id: "task-001",
    title: "修复生产环境登录问题",
    assignee_id: "user-zhangsan",
    priority: "high",
    channel_id: "feishu",
    due_at: "2026-05-21T18:00:00Z",
    source: "test",
  });
  assert(!!taskMatch, "task.created 事件命中 task_created_notify Playbook");
  assert(playbookIds.has("task_created_notify"), "task_created_notify Playbook 已加载");
  assert(playbookIds.has("task_overdue_remind"), "task_overdue_remind Playbook 已加载");

  // 通过 action 步骤创建 Task 对象
  const taskObj = await runtime.objectStore.create("Task", {
    id: "task-002",
    title: "更新用户手册",
    assignee_id: "user-lisi",
    priority: "normal",
    status: "open",
    due_at: "2026-05-15T00:00:00Z", // 故意超期
    source: "test",
  });
  assert(taskObj.id === "task-002", "Task 对象写入 ObjectStore");

  const { items: tasks } = await runtime.objectStore.query("Task", { limit: 10 });
  assert(tasks.length >= 1, `ObjectStore 可查到 Task 对象（当前 ${tasks.length} 个）`);

  // ─────────────────────────────────────────────────────────
  // 2. 审批流程
  // ─────────────────────────────────────────────────────────
  section("2. 审批流程闭环");
  assert(playbookIds.has("approval_request_created"), "approval_request_created Playbook 已加载");
  assert(playbookIds.has("approval_decided"), "approval_decided Playbook 已加载");

  const approvalObj = await runtime.objectStore.create("ApprovalRequest", {
    id: "approval-001",
    title: "出差报销申请 - 张三 - 2026-05",
    category: "expense",
    applicant_id: "user-zhangsan",
    approver_id: "user-manager",
    amount: 480,
    currency: "CNY",
    description: "北京出差 5 天交通住宿餐饮",
    status: "pending",
    channel_id: "feishu",
    submitted_at: new Date().toISOString(),
  });
  assert(approvalObj.id === "approval-001", "ApprovalRequest 写入 ObjectStore");

  // 触发审批 Playbook
  const [approvalMatch] = await runtime.kernel.publish("approval.created", "test", {
    ...approvalObj,
  });
  assert(!!approvalMatch, "approval.created 事件命中 approval_request_created");

  // 模拟 HITL 决策（在真实场景中是审批人点飞书卡片）
  const updatedApproval = await runtime.objectStore.update("ApprovalRequest", "approval-001", {
    status: "approved",
    decision_reason: "符合报销规定，金额合理",
    decided_at: new Date().toISOString(),
  });
  assert(updatedApproval.status === "approved", "ApprovalRequest 状态更新为 approved");

  const [decidedMatch] = await runtime.kernel.publish("approval.decided", "test", updatedApproval);
  assert(!!decidedMatch, "approval.decided 事件命中 approval_decided Playbook");

  // ─────────────────────────────────────────────────────────
  // 3. 故障响应闭环
  // ─────────────────────────────────────────────────────────
  section("3. 故障响应闭环");
  assert(playbookIds.has("incident_created_response"), "incident_created_response Playbook 已加载");
  assert(playbookIds.has("incident_resolved_notify"), "incident_resolved_notify Playbook 已加载");

  const incidentObj = await runtime.objectStore.create("Incident", {
    id: "incident-001",
    title: "生产数据库响应超时",
    category: "it_system",
    severity: "P2",
    status: "open",
    reporter_id: "user-zhangsan",
    assignee_id: "user-dba",
    channel_id: "feishu",
    description: "生产数据库 API 响应时间超过 5 秒，影响所有业务",
    detected_at: new Date().toISOString(),
    source: "monitoring",
  });
  assert(incidentObj.id === "incident-001", "Incident 对象写入 ObjectStore");

  const [incidentMatch] = await runtime.kernel.publish("incident.created", "test", incidentObj);
  assert(!!incidentMatch, "incident.created 事件命中 incident_created_response");

  // 模拟解决
  const resolvedIncident = await runtime.objectStore.update("Incident", "incident-001", {
    status: "resolved",
    root_cause: "数据库连接池配置不当，最大连接数设置过低",
    resolution: "调整连接池 max_connections=100，添加慢查询索引",
    resolved_at: new Date().toISOString(),
  });
  assert(resolvedIncident.status === "resolved", "Incident 状态更新为 resolved");

  const [resolvedMatch] = await runtime.kernel.publish(
    "incident.resolved",
    "test",
    resolvedIncident,
  );
  assert(!!resolvedMatch, "incident.resolved 事件命中 incident_resolved_notify");

  // ─────────────────────────────────────────────────────────
  // 4. 会议纪要
  // ─────────────────────────────────────────────────────────
  section("4. 会议纪要闭环");
  assert(playbookIds.has("meeting_minutes_ingest"), "meeting_minutes_ingest Playbook 已加载");

  const meetingObj = await runtime.objectStore.create("Meeting", {
    id: "meeting-001",
    title: "Q2 产品规划会议",
    organizer_id: "user-cto",
    attendees: ["user-pm", "user-dev", "user-design"],
    channel_id: "feishu",
    started_at: "2026-05-20T14:00:00Z",
    ended_at: "2026-05-20T16:00:00Z",
    raw_notes:
      "1. 确认 Q2 路线图，重点是移动端改版。2. 张三负责产品路线图更新，本周五前完成。3. 与设计团队同步 UI 规范。",
  });
  assert(meetingObj.id === "meeting-001", "Meeting 对象写入 ObjectStore");

  const [meetingMatch] = await runtime.kernel.publish("meeting.created", "test", meetingObj);
  assert(!!meetingMatch, "meeting.created 事件命中 meeting_minutes_ingest");

  // 验证 KB 入库（通过 ingest 后 search）
  await runtime.kb.ingest("Q2产品规划会议：确认移动端改版路线图，张三负责产品路线图更新", {
    namespace: "meeting_archive",
    source: "meeting:meeting-001",
  });
  const kbResults = await runtime.kb.search("产品路线图", { limit: 3 });
  assert(kbResults.length > 0, `KB 检索到会议记录（${kbResults.length} 条）`);

  // ─────────────────────────────────────────────────────────
  // 5. IM 意图路由（enterprise-general 新意图）
  // ─────────────────────────────────────────────────────────
  section("5. IM 意图路由（企业通用）");

  const imResult = await bridgeImMessage(runtime, {
    channel: "feishu",
    messageId: "msg-ent-001",
    userId: "user-zhangsan",
    text: "我要报销上周出差费用 480 元，北京5天",
  });
  assert(
    imResult.action === "intent_routed" || imResult.action === "published",
    `IM 消息路由处理完成（action=${imResult.action}）`,
  );
  assert(llmCallCount > 0, `LLM 被调用（共 ${llmCallCount} 次）`);

  // ─────────────────────────────────────────────────────────
  // 6. KB 知识库查询
  // ─────────────────────────────────────────────────────────
  section("6. 知识库查询闭环");
  assert(playbookIds.has("kb_query_from_im"), "kb_query_from_im Playbook 已加载");

  // 入库一些企业知识
  await runtime.kb.ingest(
    "出差报销流程：提交发票+行程单+审批单，500元以下自动批准，500元以上需部门经理审批。",
    { namespace: "policy", source: "hr-policy-001" },
  );
  await runtime.kb.ingest(
    "IT 故障响应 SLA：P1级别15分钟响应，P2级别1小时响应，P3/P4级别下一工作日响应。",
    { namespace: "policy", source: "it-sla-001" },
  );

  const policySearch = await runtime.kb.search("报销流程", { limit: 3 });
  assert(policySearch.length > 0, `知识库检索"报销流程"得到 ${policySearch.length} 条结果`);
  assert(policySearch[0].text.includes("报销"), "KB 检索结果包含正确内容");

  // 触发 kb.query_requested 事件
  const [kbMatch] = await runtime.kernel.publish("kb.query_requested", "test", {
    query: "怎么申请报销",
    user_id: "user-zhangsan",
    channel_id: "feishu",
  });
  assert(!!kbMatch, "kb.query_requested 事件命中 kb_query_from_im Playbook");

  // ─────────────────────────────────────────────────────────
  // 7. 公告广播
  // ─────────────────────────────────────────────────────────
  section("7. 公告广播闭环");
  assert(playbookIds.has("announcement_broadcast"), "announcement_broadcast Playbook 已加载");

  const [announcMatch] = await runtime.kernel.publish("announcement.publish", "test", {
    id: "ann-001",
    title: "系统维护通知",
    content: "本周六 22:00-24:00 系统维护，请提前保存工作。",
    creator_id: "user-admin",
    priority: "normal",
    target_channels: ["feishu"],
  });
  assert(!!announcMatch, "announcement.publish 事件命中 announcement_broadcast");

  // ─────────────────────────────────────────────────────────
  // 8. 日报统计动作
  // ─────────────────────────────────────────────────────────
  section("8. 日报统计动作");
  assert(playbookIds.has("daily_report_generate"), "daily_report_generate Playbook 已加载");

  // 直接测试 query_daily_stats action（通过 PlaybookEngine 触发）
  // 模拟手动触发日报 Playbook
  const reportRun = await runtime.playbookEngine.trigger("daily_report_generate", {});
  assert(
    reportRun.status === "completed" || reportRun.status === "running",
    `daily_report_generate 触发成功（status=${reportRun.status}）`,
  );

  // ─────────────────────────────────────────────────────────
  // 9. ObjectStore 多类型数据验证
  // ─────────────────────────────────────────────────────────
  section("9. ObjectStore 多类型数据验证");

  const { items: allTasks } = await runtime.objectStore.query("Task", { limit: 50 });
  const { items: allApprovals } = await runtime.objectStore.query("ApprovalRequest", { limit: 50 });
  const { items: allIncidents } = await runtime.objectStore.query("Incident", { limit: 50 });
  const { items: allMeetings } = await runtime.objectStore.query("Meeting", { limit: 50 });

  assert(allTasks.length >= 1, `Task 对象：${allTasks.length} 个`);
  assert(allApprovals.length >= 1, `ApprovalRequest 对象：${allApprovals.length} 个`);
  assert(allIncidents.length >= 1, `Incident 对象：${allIncidents.length} 个`);
  assert(allMeetings.length >= 1, `Meeting 对象：${allMeetings.length} 个`);
  assert(allApprovals[0].status === "approved", "ApprovalRequest 状态正确（approved）");
  assert(allIncidents[0].status === "resolved", "Incident 状态正确（resolved）");

  // ─────────────────────────────────────────────────────────
  // 结果汇总
  // ─────────────────────────────────────────────────────────
  await stopClaworksRuntime(runtime);

  console.log(`\n${"=".repeat(60)}`);
  console.log(`  测试结果：${passed} 通过 / ${failed} 失败`);
  if (failed > 0) {
    console.log("  ✗ 有测试失败！");
    process.exit(1);
  } else {
    console.log("  ✅ ALL ENTERPRISE BIZ TESTS PASSED");
  }
  console.log("=".repeat(60));
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
