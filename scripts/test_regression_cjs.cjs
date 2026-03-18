// Run regression test via execSync to avoid ESM loader hang
const { execSync } = require('child_process');

const steps = [
  { name: '01-scan',     action: 'scan_controllers', extra: {} },
  { name: '02-connect',  action: 'connect',           extra: { host: '127.0.0.1', allowVirtualController: true } },
  { name: '03-status',   action: 'get_status',        extra: {} },
  { name: '04-system',   action: 'get_system_info',   extra: {} },
  { name: '05-service',  action: 'get_service_info',  extra: {} },
  { name: '06-speed',    action: 'get_speed',         extra: {} },
  { name: '07-setspeed', action: 'set_speed',         extra: { speed: 30 } },
  { name: '08-joints',   action: 'get_joints',        extra: {} },
  { name: '09-world',    action: 'get_world_position',extra: {} },
  { name: '10-log',      action: 'get_event_log',     extra: { categoryId: 0, limit: 5 } },
  { name: '11-tasks',    action: 'list_tasks',        extra: {} },
  { name: '12-resetpp',  action: 'reset_program_pointer', extra: { taskName: 'T_ROB1' } },
  { name: '13-badjoints',action: 'movj',              extra: { joints: [1,2], speed: 8 }, expectErr: 'exactly 6 joint' },
];

const PLUGIN = 'file:///D:/OpenClaw/Develop/openclaw/extensions/abb-robot-real-control/index.js';
const DLL    = 'd:/OpenClaw/Develop/openclaw/extensions/abb-robot-control/src/ABBBridge.dll';
const NO_CONNECT = new Set(['scan_controllers', 'connect', 'get_version']);

function makeScript(step) {
  const paramsJson = JSON.stringify({ action: step.action, ...step.extra });
  const connectLine = NO_CONNECT.has(step.action)
    ? ''
    : "await tool.execute('c',{action:'connect',host:'127.0.0.1',allowVirtualController:true});";
  return [
    "import plugin from '" + PLUGIN + "';",
    'let tool;',
    "plugin.register({registerTool:t=>{tool=t}},{controllerHost:'127.0.0.1',controllerPort:7000,bridgeDllPath:'" + DLL + "'});",
    connectLine,
    'const r = await tool.execute(\'t\',' + paramsJson + ');',
    'const text = String(r?.content?.[0]?.text||\'\').replace(/\\s+/g,\' \');',
    'const ok = r?.details?.success !== false;',
    'console.log(JSON.stringify({name:\'' + step.name + '\',ok,text:text.substring(0,120),details:r?.details}));',
  ].join('\n');
}

const results = [];
for (const step of steps) {
  process.stdout.write('Running ' + step.name + '... ');
  try {
    const out = execSync('node --input-type=module', {
      input: makeScript(step),
      cwd: 'D:/OpenClaw/Develop/openclaw',
      timeout: 20000,
      encoding: 'utf8'
    });
    const parsed = JSON.parse(out.trim());
    if (step.expectErr) {
      parsed.ok = parsed.text.toLowerCase().includes(step.expectErr.toLowerCase());
    }
    results.push(parsed);
    console.log((parsed.ok ? 'PASS' : 'FAIL') + ' | ' + parsed.text);
  } catch (e) {
    const msg = ((e.stdout || '') + (e.stderr || '') + (e.message || '')).toString().substring(0, 150);
    results.push({ name: step.name, ok: false, text: msg });
    console.log('ERROR | ' + msg);
  }
}

const fails = results.filter(r => !r.ok).length;
console.log('\nSUMMARY total=' + results.length + ' fail=' + fails);
console.log(fails === 0 ? 'REGRESSION_OK' : 'REGRESSION_FAIL');
