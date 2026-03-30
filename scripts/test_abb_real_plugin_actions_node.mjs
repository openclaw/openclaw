import fs from "node:fs";
import plugin from "../extensions/abb-robot-real-control/index.js";

let tool = null;
plugin.register(
  {
    registerTool: (t) => {
      tool = t;
    },
  },
  {
    controllerHost: "127.0.0.1",
    controllerPort: 7000,
    bridgeDllPath: "d:/OpenClaw/Develop/openclaw/extensions/abb-robot-control/src/ABBBridge.dll",
  },
);

const steps = [
  { action: "scan_controllers", params: {} },
  { action: "connect", params: { host: "127.0.0.1", port: 7000, allowVirtualController: true } },
  { action: "get_status", params: {} },
  { action: "get_system_info", params: {} },
  { action: "get_service_info", params: {} },
  { action: "get_speed", params: {} },
  { action: "set_speed", params: { speed: 25 } },
  { action: "get_joints", params: {} },
  { action: "get_world_position", params: {} },
  { action: "get_event_log", params: { categoryId: 0, limit: 10 } },
  { action: "list_tasks", params: {} },
  {
    action: "analyze_logs",
    params: { categoryId: 0, limit: 10, error_hint: "T_ROB1 MainModule line3 error" },
  },
  { action: "movj", params: { joints: [0, 0, 0, 0, 0, 0], speed: 5 } },
];

const report = [];
for (const step of steps) {
  try {
    const res = await tool.execute(`node-${step.action}`, { action: step.action, ...step.params });
    const details = res?.details ?? {};
    const success = typeof details.success === "boolean" ? details.success : true;
    report.push({
      action: step.action,
      ok: success,
      text: String(res?.content?.[0]?.text ?? ""),
      details,
    });
  } catch (error) {
    report.push({
      action: step.action,
      ok: false,
      error: error?.message ?? String(error),
    });
  }
}

const passCount = report.filter((r) => r.ok).length;
const failCount = report.length - passCount;

const output = {
  summary: { total: report.length, pass: passCount, fail: failCount },
  report,
};

fs.writeFileSync(
  "d:/OpenClaw/Develop/openclaw/scripts/_real_plugin_actions_node_report.json",
  JSON.stringify(output, null, 2),
  "utf8",
);

console.log(`REAL_PLUGIN_ACTIONS_NODE_DONE pass=${passCount} fail=${failCount}`);
