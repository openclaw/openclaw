import plugin from '../extensions/abb-robot-real-control/index.js';

let tool;
plugin.register(
  { registerTool: (t) => { tool = t; } },
  {
    controllerHost: '127.0.0.1',
    controllerPort: 7000,
    bridgeDllPath: 'd:/OpenClaw/Develop/openclaw/extensions/abb-robot-control/src/ABBBridge.dll',
  }
);

const rows = [];
async function step(name, action, extra = {}, passWhen = null) {
  const start = Date.now();
  const r = await tool.execute(name, { action, ...extra });
  const elapsed = Date.now() - start;
  const text = String(r?.content?.[0]?.text ?? '').replace(/\s+/g, ' ');
  let ok = typeof passWhen === 'function' ? !!passWhen(r, text) : r?.details?.success !== false;
  rows.push({ name, action, ok, text, elapsed });
  console.log(`${ok ? 'PASS' : 'FAIL'} [${elapsed}ms] ${name} | ${text.substring(0,80)}`);
  return r;
}

await step('01-scan', 'scan_controllers', {}, (r) => (r?.details?.result?.total ?? 0) >= 1);
await step('02-connect', 'connect', { host: '127.0.0.1', port: 7000, allowVirtualController: true }, (r, t) => /connected/i.test(t));
await step('03-status', 'get_status', {}, (r) => r?.details?.result?.success === true);
await step('04-system', 'get_system_info', {}, (r) => r?.details?.result?.success === true);
await step('05-service', 'get_service_info', {}, (r) => r?.details?.result?.success === true);
await step('06-get-speed', 'get_speed', {}, (r) => r?.details?.result?.success === true);
await step('07-set-speed', 'set_speed', { speed: 30 }, (r) => r?.details?.result?.success === true);
const jointsRes = await step('08-joints', 'get_joints', {}, (r) => Array.isArray(r?.details?.result?.joints) && r.details.result.joints.length === 6);
await step('09-world', 'get_world_position', {}, (r) => r?.details?.result?.success === true);
await step('10-log', 'get_event_log', { categoryId: 0, limit: 10 }, (r) => r?.details?.result?.success === true);
const tasks = await step('11-tasks', 'list_tasks', {}, (r) => r?.details?.result?.success === true);
const taskName = tasks?.details?.result?.tasks?.[0]?.taskName || 'T_ROB1';
await step('12-backup', 'backup_module', { moduleName: 'MainModule', taskName, outputDir: 'd:/OpenClaw/test/_backup' }, (r) => r?.details?.result?.success === true);
await step('13-resetpp', 'reset_program_pointer', { taskName }, (r) => r?.details?.result?.success === true);
await step('14-bad-joints', 'movj', { joints: [1, 2], speed: 8 }, (r, t) => /exactly 6 joint/i.test(t));
await step('15-analyze', 'analyze_logs', { categoryId: 0, limit: 10, error_hint: 'test' }, (r) => r?.details?.success === true);

const failCount = rows.filter(r => !r.ok).length;
console.log(`\nSUMMARY total=${rows.length} fail=${failCount}`);
console.log(failCount === 0 ? 'REGRESSION_OK' : 'REGRESSION_FAIL');
