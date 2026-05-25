#!/usr/bin/env node
/**
 * OT live acceptance checklist — read-only; does not connect to real devices.
 *
 * Usage:
 *   pnpm claworks:ot-live-checklist
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { auditOtConnectorEnv } from "./lib/claworks-ot-connectivity-env.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const ENV_EXAMPLES = [
  { id: "mqtt", path: "contrib/examples/mqtt.env.example" },
  { id: "opcua", path: "contrib/examples/opcua.env.example" },
  { id: "modbus", path: "contrib/examples/modbus.env.example" },
  {
    id: "production-overlay",
    path: "contrib/examples/claworks-personal-production.env.example",
  },
];

function status(ok, label, detail = "") {
  const mark = ok ? "[✓]" : "[!]";
  const suffix = detail ? ` — ${detail}` : "";
  console.log(`${mark} ${label}${suffix}`);
}

console.log("ClaWorks OT 实机签收检查清单（只读，不连真机）");
console.log("文档：docs/claworks/ot-live.md\n");

console.log("── 环境变量示例文件 ──");
for (const ex of ENV_EXAMPLES) {
  const full = join(root, ex.path);
  status(existsSync(full), ex.id, ex.path);
}

console.log("\n── 模拟基线（本地/CI，无需实机）──");
console.log("[ ] pnpm claworks:ot-dry-run → ALL OT DRY-RUN CHECKS PASSED");

console.log("\n── 生产配置 ──");
console.log("[ ] CLAWORKS_PRODUCTION=1（或 production_mode=true）");
console.log("[ ] pnpm claworks:doctor --fix — 无 connectors_simulate / connectors_echo_demo");
console.log("[ ] claworks.json connectors.*.simulate: false");
console.log(
  "[ ] mqtt/opcua/modbus endpoint、topic、凭证已填（对照 contrib/examples/*.env.example）",
);
console.log("[ ] MQTT：npm install mqtt（实 broker）");
console.log("[ ] OPC-UA：pip install asyncua");
console.log("[ ] Modbus：pip install pymodbus");

console.log("\n── Gateway 与实机验证 ──");
console.log("[ ] pnpm claworks:gateway（或 ai.claworks.gateway）已重启");
console.log("[ ] curl http://127.0.0.1:18800/v1/connectors — 各连接器 healthy");
console.log("[ ] curl -X POST http://127.0.0.1:18800/v1/doctor/run?fix=true — 通过");
console.log("[ ] 触发 OT 事件 — Playbook 匹配与工单创建");

console.log("\n── 与 dry-run 对比 ──");
console.log("[ ] dry-run 仅验证 simulate 路径；实机需 simulate:false + 上节全绿");

const configPath =
  process.env.CLAWORKS_CONFIG?.trim() || join(process.env.HOME ?? "", ".claworks/claworks.json");
if (existsSync(configPath)) {
  try {
    const raw = readFileSync(configPath, "utf8");
    const cfg = JSON.parse(raw);
    const connectors = cfg?.plugins?.entries?.["claworks-robot"]?.config?.connectors ?? {};
    const ids = Object.keys(connectors);
    console.log(`\n── 本地配置快照（${configPath}）──`);
    if (ids.length === 0) {
      console.log("[ ] connectors 未配置");
    } else {
      for (const id of ids) {
        const sim = connectors[id]?.simulate;
        const simLabel =
          sim === true ? "simulate:true ⚠" : sim === false ? "simulate:false ✓" : "simulate:未设";
        console.log(`[ ] ${id}: ${simLabel}`);
      }
      const envFindings = auditOtConnectorEnv(connectors);
      if (envFindings.length > 0) {
        console.log("\n── 实机 env 校验（只读）──");
        for (const f of envFindings) {
          status(false, `${f.id} (${f.preset})`, f.message);
        }
      } else if (Object.values(connectors).some((c) => c?.simulate === false)) {
        console.log("\n── 实机 env 校验（只读）──");
        status(true, "live connector env", "required vars present, no simulate env conflict");
      }
    }
  } catch {
    console.log(`\n[!] 无法解析 ${configPath}`);
  }
} else {
  console.log(`\n── 本地配置 ──`);
  console.log(`[ ] ${configPath} 不存在 — 先 pnpm claworks:init`);
}

console.log("\n完成签收后更新 docs/RELEASE-CHECKLIST.md 与 OPENCLAW-ALIGNMENT-AUDIT.md §8.6。");
