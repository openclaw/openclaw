// Motion verify using async spawn
const { spawn } = require('child_process');

const PLUGIN = 'file:///D:/OpenClaw/Develop/openclaw/extensions/abb-robot-real-control/index.js';
const DLL = 'd:/OpenClaw/Develop/openclaw/extensions/abb-robot-control/src/ABBBridge.dll';
const CWD = 'D:/OpenClaw/Develop/openclaw';

function runScript(jsCode, timeoutMs) {
  return new Promise((resolve, reject) => {
    const proc = spawn('node', ['--input-type=module'], { cwd: CWD, stdio: ['pipe','pipe','pipe'] });
    let out = '', err = '';
    proc.stdout.on('data', d => out += d);
    proc.stderr.on('data', d => err += d);
    const timer = setTimeout(() => { proc.kill(); reject(new Error('ETIMEDOUT after ' + timeoutMs + 'ms')); }, timeoutMs);
    proc.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error((err || out).substring(0, 200)));
      try { resolve(JSON.parse(out.trim())); }
      catch(e) { reject(new Error('parse: ' + out.substring(0, 100))); }
    });
    proc.stdin.write(jsCode);
    proc.stdin.end();
  });
}

function makeCode(params) {
  const conn = "await tool.execute('c',{action:'connect',host:'127.0.0.1',allowVirtualController:true});";
  return [
    "import plugin from '" + PLUGIN + "';",
    'let tool;',
    "plugin.register({registerTool:t=>{tool=t}},{controllerHost:'127.0.0.1',controllerPort:7000,bridgeDllPath:'" + DLL + "'});",
    conn,
    'const r = await tool.execute(\'t\',' + JSON.stringify(params) + ');',
    'const text = String(r?.content?.[0]?.text||\'\').replace(/\\s+/g,\' \');',
    'process.stdout.write(JSON.stringify({ok:r?.details?.success!==false,text,details:r?.details}));',
  ].join('\n');
}

async function step(name, params, passWhen, ms) {
  process.stdout.write('  ' + name + '... ');
  try {
    const r = await runScript(makeCode(params), ms || 25000);
    const ok = passWhen ? passWhen(r) : r.ok;
    console.log((ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m') + ' | ' + r.text);
    return { ok, r };
  } catch(e) {
    console.log('\x1b[31mERROR\x1b[0m | ' + e.message);
    return { ok: false, r: null };
  }
}

async function main() {
  console.log('\n=== ABB Robot Motion & Status Verification ===\n');
  const results = [];

  let res;
  res = await step('GET STATUS', {action:'get_status'}, r => r?.details?.result?.success);
  results.push({name:'GET STATUS', ok: res.ok});

  res = await step('GET JOINTS', {action:'get_joints'}, r => Array.isArray(r?.details?.result?.joints));
  results.push({name:'GET JOINTS', ok: res.ok});

  const j = res.r?.details?.result?.joints;
  if (j && j.length === 6) {
    console.log('  Current joints:', j.map(x => x.toFixed(2)).join(', '));
    const target = [...j];
    target[0] = parseFloat((target[0] + 3).toFixed(2));
    console.log('  Target (+3 J1):', target.map(x => x.toFixed(2)).join(', '));

    res = await step('MOVJ +3deg',
      {action:'movj', joints:target, speed:10, zone:'fine', motionTimeoutMs:45000},
      r => /move executed/i.test(r?.text||''), 90000);
    results.push({name:'MOVJ +3deg', ok: res.ok});

    res = await step('GET JOINTS AFTER', {action:'get_joints'}, r => Array.isArray(r?.details?.result?.joints));
    results.push({name:'GET JOINTS AFTER', ok: res.ok});
    const aj = res.r?.details?.result?.joints;
    if (aj) {
      const delta = Math.abs(aj[0] - target[0]);
      const acc = delta < 0.5;
      console.log('  J1:', aj[0].toFixed(2), '| delta:', delta.toFixed(3), acc ? '\x1b[32m(OK)\x1b[0m' : '\x1b[31m(DEVIATION)\x1b[0m');
      results.push({name:'J1 ACCURACY', ok: acc});
    }

    console.log('  Returning...');
    res = await step('MOVJ RETURN',
      {action:'movj', joints:j, speed:10, zone:'fine', motionTimeoutMs:45000},
      r => /move executed/i.test(r?.text||''), 90000);
    results.push({name:'MOVJ RETURN', ok: res.ok});
  }

  res = await step('WORLD POS', {action:'get_world_position'}, r => r?.details?.result?.success);
  results.push({name:'WORLD POS', ok: res.ok});

  const fails = results.filter(r => !r.ok).length;
  console.log('\n' + '='.repeat(50));
  console.log('MOTION VERIFY: total=' + results.length + ' fail=' + fails);
  console.log(fails === 0 ? '\x1b[32mMOTION_VERIFY_OK\x1b[0m' : '\x1b[31mMOTION_VERIFY_FAIL\x1b[0m');
}

main().catch(e => { console.error(e.message); process.exit(1); });
