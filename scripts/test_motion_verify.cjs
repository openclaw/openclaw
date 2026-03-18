// Verify robot motion and status
const { execSync } = require('child_process');

const PLUGIN = 'file:///D:/OpenClaw/Develop/openclaw/extensions/abb-robot-real-control/index.js';
const DLL = 'd:/OpenClaw/Develop/openclaw/extensions/abb-robot-control/src/ABBBridge.dll';

function run(params, timeoutMs) {
  const connectLine = params.action === 'scan_controllers' ? '' :
    "await tool.execute('c',{action:'connect',host:'127.0.0.1',allowVirtualController:true});";
  const script = [
    "import plugin from '" + PLUGIN + "';",
    'let tool;',
    "plugin.register({registerTool:t=>{tool=t}},{controllerHost:'127.0.0.1',controllerPort:7000,bridgeDllPath:'" + DLL + "'});",
    connectLine,
    'const r = await tool.execute(\'t\',' + JSON.stringify(params) + ');',
    'const text = String(r?.content?.[0]?.text||\'\').replace(/\\s+/g,\' \');',
    'process.stdout.write(JSON.stringify({ok:r?.details?.success!==false,text,details:r?.details}));',
  ].join('\n');
  const out = execSync('node --input-type=module', {
    input: script, cwd: 'D:/OpenClaw/Develop/openclaw',
    timeout: timeoutMs || 25000, encoding: 'utf8'
  });
  return JSON.parse(out.trim());
}

const results = [];
function step(name, params, passWhen, timeoutMs) {
  process.stdout.write('  ' + name + '... ');
  try {
    const r = run(params, timeoutMs);
    const ok = passWhen ? passWhen(r) : r.ok;
    console.log((ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m') + ' | ' + r.text);
    results.push({ name, ok, text: r.text, details: r.details });
    return r;
  } catch(e) {
    const msg = (e.stdout || e.message || '').toString().substring(0, 120);
    console.log('\x1b[31mERROR\x1b[0m | ' + msg);
    results.push({ name, ok: false, text: msg });
    return null;
  }
}

console.log('\n=== ABB Robot Motion & Status Verification ===\n');

// 1. Get current state
const statusR = step('GET STATUS', { action: 'get_status' }, r => r?.details?.result?.success);
const jointsR = step('GET JOINTS', { action: 'get_joints' }, r => Array.isArray(r?.details?.result?.joints));

if (jointsR?.details?.result?.joints) {
  const j = jointsR.details.result.joints;
  console.log('  Current joints:', j.map(x => x.toFixed(2)).join(', '));

  // 2. Small validation move: J1 += 3 degrees
  const target = [...j];
  target[0] = parseFloat((target[0] + 3).toFixed(2));
  console.log('\n  Moving J1 by +3 deg to:', target.map(x => x.toFixed(2)).join(', '));
  step('MOVJ +3deg', { action: 'movj', joints: target, speed: 10, zone: 'fine' },
    r => /move executed/i.test(r?.text || ''), 60000);

  // 3. Verify position after move
  const after = step('GET JOINTS AFTER', { action: 'get_joints' }, r => Array.isArray(r?.details?.result?.joints));
  if (after?.details?.result?.joints) {
    const aj = after.details.result.joints;
    console.log('  Joints after move:', aj.map(x => x.toFixed(2)).join(', '));
    const delta = Math.abs(aj[0] - target[0]);
    console.log('  J1 delta from target:', delta.toFixed(3), delta < 0.5 ? '\x1b[32m(OK)\x1b[0m' : '\x1b[31m(DEVIATION)\x1b[0m');
    results.push({ name: 'J1 POSITION ACCURACY', ok: delta < 0.5, text: 'delta=' + delta.toFixed(3) });
  }

  // 4. Return to original position
  console.log('\n  Returning to original position...');
  step('MOVJ RETURN', { action: 'movj', joints: j, speed: 10, zone: 'fine' },
    r => /move executed/i.test(r?.text || ''), 60000);

  // 5. Final state check
  step('FINAL STATUS', { action: 'get_status' }, r => r?.details?.result?.success);
  step('WORLD POS', { action: 'get_world_position' }, r => r?.details?.result?.success);
}

// Summary
const fails = results.filter(r => !r.ok).length;
console.log('\n' + '='.repeat(50));
console.log('MOTION VERIFY: total=' + results.length + ' fail=' + fails);
console.log(fails === 0 ? '\x1b[32mMOTION_VERIFY_OK\x1b[0m' : '\x1b[31mMOTION_VERIFY_FAIL\x1b[0m');
