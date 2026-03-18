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

async function stepWithTimeout(name, action, extra = {}, timeoutMs = 20000) {
  const start = Date.now();
  console.log(`START ${name}...`);
  const promise = tool.execute(name, { action, ...extra });
  const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('TIMEOUT')), timeoutMs));
  try {
    const r = await Promise.race([promise, timeout]);
    const elapsed = Date.now() - start;
    const text = String(r?.content?.[0]?.text ?? '').replace(/\s+/g, ' ').substring(0, 80);
    const ok = r?.details?.success !== false;
    console.log(`${ok?'PASS':'FAIL'} [${elapsed}ms] ${name}: ${text}`);
    return r;
  } catch (e) {
    console.log(`TIMEOUT/ERROR [${Date.now()-start}ms] ${name}: ${e.message}`);
    return null;
  }
}

await stepWithTimeout('01-scan', 'scan_controllers');
await stepWithTimeout('02-connect', 'connect', { host: '127.0.0.1', allowVirtualController: true });
await stepWithTimeout('03-status', 'get_status');
await stepWithTimeout('04-system', 'get_system_info');
await stepWithTimeout('05-service', 'get_service_info');
await stepWithTimeout('06-speed', 'get_speed');
await stepWithTimeout('07-joints', 'get_joints');
await stepWithTimeout('08-world', 'get_world_position');
await stepWithTimeout('09-log', 'get_event_log', { categoryId: 0, limit: 5 });
await stepWithTimeout('10-tasks', 'list_tasks');
await stepWithTimeout('11-resetpp', 'reset_program_pointer', { taskName: 'T_ROB1' });
await stepWithTimeout('12-bad-joints', 'movj', { joints: [1,2], speed: 8 });
console.log('ALL STEPS DONE');
