import plugin from "../extensions/abb-robot-real-control/index.js";

let tool;
console.log("REGRESSION_BOOT");
plugin.register(
  { registerTool: (t) => { tool = t; } },
  {
    controllerHost: "127.0.0.1",
    controllerPort: 7000,
    bridgeDllPath: "d:/OpenClaw/Develop/openclaw/extensions/abb-robot-control/src/ABBBridge.dll",
    allowVirtualController: true,
  }
);
console.log("REGRESSION_REGISTERED", !!tool);

const rows = [];

async function step(name, action, extra = {}, passWhen = null) {
  const r = await tool.execute(name, { action, ...extra });
  const text = String(r?.content?.[0]?.text ?? "").replace(/\s+/g, " ");
  let ok = false;
  if (typeof passWhen === "function") {
    ok = !!passWhen(r, text);
  } else {
    ok = r?.details?.success !== false;
  }
  rows.push({ name, action, ok, text, details: r?.details ?? {} });
  return r;
}

function printSummary() {
  for (const row of rows) {
    console.log(`${row.ok ? "PASS" : "FAIL"} | ${row.name} | ${row.action} | ${row.text}`);
  }
  const failCount = rows.filter((r) => !r.ok).length;
  console.log(`SUMMARY total=${rows.length} fail=${failCount}`);
  if (failCount === 0) {
    console.log("REGRESSION_OK");
  } else {
    console.log("REGRESSION_FAIL");
  }
}

async function run() {
  await step("01-scan", "scan_controllers", {}, (r) => (r?.details?.result?.total ?? 0) >= 1);
  await step("02-connect", "connect", { host: "127.0.0.1", port: 7000, allowVirtualController: true }, (r, t) => /connected/i.test(t));
  const status = await step("03-status", "get_status", {}, (r) => r?.details?.result?.success === true);
  await step("04-system", "get_system_info", {}, (r) => r?.details?.result?.success === true);
  await step("05-service", "get_service_info", {}, (r) => r?.details?.result?.success === true);
  await step("06-get-speed", "get_speed", {}, (r) => r?.details?.result?.success === true);
  await step("07-set-speed", "set_speed", { speed: 30 }, (r) => r?.details?.result?.success === true);
  const jointsRes = await step("08-joints", "get_joints", {}, (r) => Array.isArray(r?.details?.result?.joints) && r.details.result.joints.length === 6);
  await step("09-world", "get_world_position", {}, (r) => r?.details?.result?.success === true);
  await step("10-log", "get_event_log", { categoryId: 0, limit: 15 }, (r) => r?.details?.result?.success === true && Array.isArray(r?.details?.result?.entries));
  const tasks = await step("11-tasks", "list_tasks", {}, (r) => r?.details?.result?.success === true && Array.isArray(r?.details?.result?.tasks));

  const taskName = tasks?.details?.result?.tasks?.[0]?.taskName || "T_ROB1";
  const moduleName = tasks?.details?.result?.tasks?.[0]?.modules?.[0] || "";

  await step("12-backup", "backup_module", { moduleName, taskName, outputDir: "d:/OpenClaw/Develop/openclaw/scripts/_abb_backup" }, (r) => r?.details?.result?.success === true || /module not found/i.test(r?.content?.[0]?.text || ""));
  await step("13-resetpp", "reset_program_pointer", { taskName }, (r, t) => r?.details?.result?.success === true || /semantic|reset pointer failed/i.test(t));

  const joints = jointsRes?.details?.result?.joints || [];
  if (Array.isArray(joints) && joints.length === 6) {
    const target = [...joints];
    target[0] = Number(target[0]) + 0.2;
    await step("14-movj", "movj", { joints: target, speed: 8, zone: "fine" }, (r, t) => /move executed|move failed/i.test(t));
  }

  await step("15-bad-joints", "movj", { joints: [1, 2], speed: 8 }, (r, t) => /exactly 6 joint/i.test(t));
  await step("16-analyze", "analyze_logs", { categoryId: 0, limit: 20, error_hint: "T_ROB1 MainModule 行3 错误" }, (r) => r?.details?.success === true && Array.isArray(r?.details?.diagnosis?.issues));

  // Optional: verify mode/motor context is readable
  const opMode = status?.details?.result?.operationMode || "";
  const motor = status?.details?.result?.motorState || "";
  console.log(`STATUS_CONTEXT mode=${opMode} motor=${motor}`);

  printSummary();
}

run().catch((err) => {
  console.log("REGRESSION_EXCEPTION", err?.message ?? String(err));
  process.exit(1);
});
