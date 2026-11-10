#!/usr/bin/env node
// Standalone installed C -> Q proof. Only packaging helpers are imported from tooling.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { ID, ORIGINAL, PRIVATE, SETTINGS, pluginSource } from './fixture.mjs';
const args = process.argv.slice(2), options = {};
for (let i = 0; i < args.length; i += 2) {
  assert(/^--[a-z-]+$/.test(args[i]) && args[i + 1], 'Expected --option value pairs (see README)');
  options[args[i].slice(2)] = args[i + 1];
}
if (options.help) { console.log('See README.md: --candidate C.tgz|built-checkout --tooling checkout --output new-directory [--cases success,relative,absolute,failure,cancel] [--runtimes auto|node|node,bun]'); process.exit(0); }
assert(process.platform === 'linux', 'Disposable Linux host only');
assert(options.candidate && options.output, 'Missing --candidate and --output');
assert(Object.keys(options).every(k => ['candidate','output','tooling','cases','runtimes','timeout-seconds','budget-seconds'].includes(k)), 'Unknown option');
const input = fs.realpathSync(options.candidate);
const tooling = fs.realpathSync(options.tooling || fileURLToPath(new URL('./tooling',import.meta.url)));
const output = path.resolve(options.output);
assert(!fs.existsSync(output), 'Output must be a NEW directory; never reuses prior state');
assert(!fs.statSync(input).isDirectory() || !output.startsWith(input + path.sep), 'Output must not be inside input checkout');
fs.mkdirSync(output, { mode: 0o700 });
const write = (file, value) => fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value, null, 2) + String.fromCharCode(10), { mode: 0o600 });
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const digest = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const mkdir = dir => fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
const inside = (root, target) => target.startsWith(root + path.sep);
const timeout = Number(options['timeout-seconds'] || 900) * 1000;
const budget = Number(options['budget-seconds'] || 3600) * 1000;
assert(Number.isSafeInteger(budget) && budget >= 1000 && budget <= 14400000,'Overall budget must be 1..14400 seconds');
const deadline=Date.now()+budget;
assert(Number.isSafeInteger(timeout) && timeout >= 1000 && timeout <= 3600000, 'Timeout must be 1..3600 seconds per command');
const cases = (options.cases || 'success,relative,absolute,failure,cancel').split(',');
assert(cases.length <= 5 && new Set(cases).size === cases.length && cases.every(c => ['success','relative','absolute','failure','cancel'].includes(c)), 'Invalid cases');
const summary = { status: 'running', scope: 'installed-candidate-updater-to-derived-Q', startedAt: new Date().toISOString(),
  output, input, tooling, commands: [], cells: [], limitations: [
    'No live hosted run is implied by this harness. Only passed cells in this receipt are evidence.',
    'Q is a version-stamped same-schema C derivative, not a published release or schema-upgrade proof.',
    'Fixture plugin is ordinary configured code, not a security sandbox test for arbitrary malicious plugin JavaScript.',
    'Traversal cells exercise outside-package data links; no source mutation races or mid-copy cancellation coverage.',
    'Cancellation is after an externally observed private registration/write, not during data copying.',
    'Bun rows launch the installed npm C CLI with Bun; they do not cover Bun global package-manager installation.'
  ] };
const save = () => write(path.join(output, 'summary.json'), summary);
save();
// Minimal allowlist: no inherited OPENCLAW_, OCM_, NODE_OPTIONS, auth, or cloud credentials.
function isolatedEnv(root) {
  for (const dir of ['home','state','tmp','cache','config','data','xdg-state','npm-prefix','workspace']) mkdir(path.join(root, dir));
  return { PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8', TZ: 'UTC',
    HOME: path.join(root,'home'), USERPROFILE: path.join(root,'home'),
    TMPDIR: path.join(root,'tmp'), TMP: path.join(root,'tmp'), TEMP: path.join(root,'tmp'),
    XDG_CACHE_HOME: path.join(root,'cache'), XDG_CONFIG_HOME: path.join(root,'config'),
    XDG_DATA_HOME: path.join(root,'data'), XDG_STATE_HOME: path.join(root,'xdg-state'),
    OPENCLAW_HOME: path.join(root,'home'), OPENCLAW_STATE_DIR: path.join(root,'state'),
    OPENCLAW_CONFIG_PATH: path.join(root,'state','openclaw.json'),
    OPENCLAW_NO_ONBOARD: '1', OPENCLAW_NO_PROMPT: '1', OPENCLAW_NO_AUTO_UPDATE: '1',
    OPENCLAW_DISABLE_BONJOUR: '1', CI: 'true',
    npm_config_prefix: path.join(root,'npm-prefix'), NPM_CONFIG_PREFIX: path.join(root,'npm-prefix'),
    npm_config_cache: path.join(root,'cache','npm'), npm_config_audit: 'false', npm_config_fund: 'false',
    npm_config_fetch_retries: '1', npm_config_fetch_timeout: '60000',
    ...(process.env.npm_config_registry ? { npm_config_registry: process.env.npm_config_registry } : {}) };
}
const base = isolatedEnv(path.join(output, 'packaging'));
function which(name) {
  const result = spawnSync('sh', ['-c', 'command -v "$1"', 'sh', name], { env: base, encoding:'utf8' });
  return result.status === 0 && result.stdout.trim() ? fs.realpathSync(result.stdout.trim()) : null;
}
// Bounded logs, timeout and process-group drainage. No retry of an uncertain update.
async function run(label, command, argv, env, cwd, observe) {
  assert(Date.now()<deadline,'Overall harness budget exhausted');
  const prefix = path.join(output, label), maxBytes = 8 * 1024 * 1024;
  const out = fs.openSync(prefix + '.out', 'wx', 0o600), err = fs.openSync(prefix + '.err', 'wx', 0o600);
  const row = { label, command, argv, cwd, startedAt: Date.now(), status: 'running', stdout: label+'.out', stderr:label+'.err' };
  summary.commands.push(row); save();
  let bytes = 0, failure, killTimer, child;
  const signalGroup = signal => { try { process.kill(-child.pid, signal); } catch(e) { if(e.code !== 'ESRCH') throw e; } };
  const stop = reason => { if (failure) return; failure = reason; signalGroup('SIGTERM'); killTimer = setTimeout(() => signalGroup('SIGKILL'), 3000); };
  try {
    child = spawn(command, argv, { cwd, env, detached: true, stdio: ['ignore','pipe','pipe'] });
    for (const [stream, fd] of [[child.stdout,out],[child.stderr,err]]) stream.on('data', chunk => {
      const available = Math.max(0,maxBytes-bytes); if(available) fs.writeSync(fd,chunk.subarray(0,available));
      bytes += chunk.length; if(bytes > maxBytes) stop('log-limit-exceeded');
    });
    const timer = setTimeout(() => stop('timeout'), Math.min(timeout,Math.max(1,deadline-Date.now())));
    const watcher = observe ? setInterval(() => { try { observe(child, row); } catch(e) { stop('observer: '+e.message); } }, 100) : null;
    const result = await new Promise(resolve => {
      child.once('error', e => { failure = e.message; resolve({ code:null, signal:null }); });
      child.once('close', (code,signal) => resolve({code,signal}));
    });
    clearTimeout(timer); clearTimeout(killTimer); clearInterval(watcher);
    if(observe) { try { observe(child,row); } catch(e) { failure ||= 'observer: '+e.message; } }
    // A detached grandchild must not outlive this bounded command.
    let groupRemained = false;
    try { process.kill(-child.pid,0); groupRemained = true; } catch(e) { if(e.code !== 'ESRCH') throw e; }
    if(groupRemained) { signalGroup('SIGKILL'); failure ||= 'child-process-group-remained'; }
    Object.assign(row,result,{status: failure ? 'failed' : 'completed', failure: failure || null, elapsedMs: Date.now()-row.startedAt, bytes, groupRemained});
    save(); return { ...row, text: fs.readFileSync(prefix+'.out','utf8') + String.fromCharCode(10) + fs.readFileSync(prefix+'.err','utf8') };
  } finally { fs.closeSync(out); fs.closeSync(err); }
}
const requireOk = r => assert(r.code === 0 && !r.failure, r.label + ': '+(r.failure || 'exit '+r.code));
// Only bounded depth and no links: observer never follows fixture traversal links.
function findMarkers(roots) {
  const found = []; let count = 0;
  const walk = (dir,depth) => {
    if(depth > 4) return;
    let entries; try { entries = fs.readdirSync(dir,{withFileTypes:true}); } catch(e) { if(e.code==='ENOENT') return; throw e; }
    for(const e of entries) {
      assert(++count < 6000, 'observer directory budget exceeded');
      const file = path.join(dir,e.name);
      if(e.isFile() && e.name === 'hosted-proof-private.json') found.push(file);
      else if(e.isDirectory() && !['node_modules','workspace','.git'].includes(e.name)) walk(file,depth+1);
    }
  };
  for(const root of roots) walk(root,0);
  return found;
}
try {
  const node = which('node'), npm = which('npm'), bun = which('bun');
  assert(node && npm, 'Node and npm required');
  summary.hostRuntime = { node, version: spawnSync(node,['--version'],{env:base,encoding:'utf8'}).stdout.trim(), bun,
    bunVersion: bun ? spawnSync(bun,['--version'],{env:base,encoding:'utf8'}).stdout.trim() : null };
  const requested = options.runtimes || 'auto';
  const runtimes = requested === 'auto' ? ['node',...(bun ? ['bun']:[])] : requested.split(',');
  assert(runtimes.length <= 2 && new Set(runtimes).size === runtimes.length && runtimes.every(r=>['node','bun'].includes(r)), 'Invalid runtimes');
  let candidate = input;
  if(fs.statSync(input).isDirectory()) {
    const copy = path.join(output,'built-checkout-copy');
    // Copy before canonical packer: it temporarily edits manifests/inventory/changelog.
    requireOk(await run('copy-built-checkout','cp',['-a',input,copy],base,output));
    // The packer writes source-owned files and stages node_modules/@openclaw/ai.
    // Reject links that could route those writes back to the caller's checkout.
    for(const relative of ['node_modules','node_modules/@openclaw']) {
      const p=path.join(copy,relative);
      if(fs.existsSync(p)) assert(!fs.lstatSync(p).isSymbolicLink(),'Copied packer parent is a symlink: '+relative);
    }
    const checkOwned = dir => {
      for(const e of fs.readdirSync(dir,{withFileTypes:true})) {
        if(['node_modules','.git'].includes(e.name)) continue;
        const p=path.join(dir,e.name);
        if(e.isSymbolicLink()) assert(fs.realpathSync(p).startsWith(copy+path.sep),'Copied source link escapes: '+p);
        else if(e.isDirectory()) checkOwned(p);
      }
    };
    checkOwned(copy);
    candidate = path.join(output,'C.tgz');
    requireOk(await run('pack-C',node,[path.join(copy,'scripts/package-openclaw-for-docker.mjs'), '--source-dir',copy,
      '--skip-build','--allow-unreleased-changelog','--output-dir',output,'--output-name','C.tgz'],base,output));
  }
  const fixtureHelper = path.join(tooling,'scripts/e2e/lib/update-first-hop-package-fixtures.mjs');
  const q = path.join(output,'Q.tgz');
  const generated = await run('derive-Q',node,[fixtureHelper,'first-hop-tarball',candidate,q,'8'],base,output);
  requireOk(generated);
  const fixture = JSON.parse(fs.readFileSync(path.join(output,'derive-Q.out'),'utf8'));
  summary.artifacts = { C: {path:candidate,sha256:digest(candidate),version:fixture.sourceVersion},
    Q: {path:q,sha256:digest(q),version:fixture.targetVersion}, derivation:fixture };
  assert(summary.artifacts.C.version !== summary.artifacts.Q.version);
  assert.equal(fixture.sourceSha256,summary.artifacts.C.sha256); assert.equal(fixture.targetSha256,summary.artifacts.Q.sha256);
  save();
  for(const runtime of runtimes) for(const name of cases) {
    const cell = { name, runtime, status:'running' }; summary.cells.push(cell); save();
    try {
      const executable = runtime === 'bun' ? bun : node;
      if(!executable) { Object.assign(cell,{status:'blocked',reason:'Requested Bun runtime unavailable'}); continue; }
      const root = path.join(output,runtime+'-'+name); mkdir(root);
      const env = isolatedEnv(root), state = env.OPENCLAW_STATE_DIR, prefix = env.npm_config_prefix;
      env.PATH = path.join(prefix,'bin') + ':' + env.PATH;
      const pkg = path.join(prefix,'lib/node_modules/openclaw'), bin = path.join(prefix,'bin/openclaw');
      assert.equal(digest(candidate),summary.artifacts.C.sha256,'C tarball changed');
      assert.equal(digest(q),summary.artifacts.Q.sha256,'Q tarball changed');
      requireOk(await run(runtime+'-'+name+'-install',npm,['install','--global','--no-audit','--no-fund',candidate],env,root));
      assert.equal(read(path.join(pkg,'package.json')).version,summary.artifacts.C.version,'C not installed');
      const plugin = path.join(root,'plugin'), external = path.join(root,'outside-live','asset-owner'); mkdir(plugin); mkdir(external);
      const sourceAsset = path.join(external,'config.txt'); write(sourceAsset,ORIGINAL);
      write(path.join(external,'package.json'),{name:'external-asset-owner',version:'1.0.0'});
      write(path.join(plugin,'package.json'),{name:ID,version:'1.0.0',type:'module',openclaw:{extensions:['./index.mjs']}});
      write(path.join(plugin,'openclaw.plugin.json'),{id:ID,name:'Hosted data proof',activation:{onStartup:true},configSchema:{type:'object',additionalProperties:false,properties:{label:{type:'string'},retained:{type:'number'}}}});
      write(path.join(plugin,'index.mjs'),pluginSource({liveState:state,sourceAsset,mode:name}));
      let target = sourceAsset;
      if(name === 'relative') target = path.relative(plugin,sourceAsset);
      if(name === 'absolute') { const chain = path.join(external,'chain.txt'); fs.symlinkSync(sourceAsset,chain); target=chain; }
      fs.symlinkSync(target,path.join(plugin,'config.txt'));
      fs.symlinkSync(sourceAsset,path.join(plugin,'second.txt'));
      const config = { gateway:{mode:'local',bind:'loopback',auth:{mode:'token',token:'isolated-hosted-proof-token'},controlUi:{enabled:true,experimental:{customPlugins:false}}},
        agents:{defaults:{workspace:path.join(root,'workspace')}},
        plugins:{enabled:true,allow:[ID],slots:{memory:'none'},load:{paths:[plugin]},entries:{[ID]:{enabled:true,config:SETTINGS}}} };
      write(env.OPENCLAW_CONFIG_PATH,config);
      const cli = (label,argv,observe) => run(runtime+'-'+name+'-'+label,executable,[bin,...argv],env,root,observe);
      requireOk(await cli('config-before',['config','validate','--json']));
      const pre = await cli('plugins-before',['plugins','list','--json']); requireOk(pre);
      const list = JSON.parse(fs.readFileSync(path.join(output,runtime+'-'+name+'-plugins-before.out'),'utf8'));
      assert(list.plugins?.some(p=>p.id===ID && p.enabled !== false && p.status !== 'error'), 'Enabled fixture not discovered');
      cell.source = { assetSha256:digest(sourceAsset),pluginSha256:digest(path.join(plugin,'index.mjs')),link:fs.readlinkSync(path.join(plugin,'config.txt')) };
      const configBefore = digest(env.OPENCLAW_CONFIG_PATH), captured = new Set(); let cancelled = false;
      const observe = (child,row) => {
        for(const marker of findMarkers([env.TMPDIR,state])) {
          if(captured.has(marker)) continue;
          let proof; try { proof = read(marker); } catch(e) { if(e.code==='ENOENT' || e instanceof SyntaxError) continue; throw e; }
          assert.equal(proof.kind,'private-register-write'); assert.notEqual(proof.state,state);
          assert(inside(root,proof.state),'Snapshot outside isolated cell: cannot attest confinement');
          assert.equal(proof.sourceAsset,sourceAsset); assert.deepEqual(proof.settings,SETTINGS);
          assert.equal(proof.after,PRIVATE); assert.equal(fs.readFileSync(proof.asset,'utf8'),PRIVATE);
          assert.equal(fs.readFileSync(proof.alias,'utf8'),ORIGINAL); assert.equal(fs.lstatSync(proof.asset).isSymbolicLink(),false);
          assert.equal(digest(sourceAsset),cell.source.assetSha256); assert.equal(digest(path.join(plugin,'index.mjs')),cell.source.pluginSha256);
          assert.equal(digest(env.OPENCLAW_CONFIG_PATH),configBefore,'Live config changed during private write');
          captured.add(marker); (cell.privateWrites ||= []).push(proof);
          write(path.join(root,'private-write-'+captured.size+'.json'),proof); save();
          if(name==='cancel' && !cancelled) {
            cancelled=true; row.cancellation={signal:'SIGINT',afterPrivateWrite:true,at:Date.now(),pid:child.pid}; save();
            child.kill('SIGINT');
          }
        }
      };
      const result = await cli('update',['update','--tag','file:'+q,'--yes','--no-restart','--json','--timeout',String(timeout/1000)],observe);
      assert(cell.privateWrites?.length, 'BLOCKED: updater never produced an observed private registration/write; admission or helper-only output is not proof');
      const text = result.text;
      const ledger = await run(runtime+'-'+name+'-ledger',node,[fileURLToPath(new URL('./ledger.mjs',import.meta.url)),path.join(state,'state','openclaw.sqlite')],env,root);
      requireOk(ledger);
      cell.ledger=JSON.parse(fs.readFileSync(path.join(output,runtime+'-'+name+'-ledger.out'),'utf8'));
      assert.equal(cell.ledger.length,1,'Expected exactly one real update invocation');
      const steps=cell.ledger[0].steps;
      assert(steps.some(s=>s.step==='candidate-state-snapshot' && s.status==='completed' && s.exitCode===0),'Missing completed real snapshot receipt');
      assert(steps.some(s=>s.step==='candidate-doctor' && (name==='failure' ? typeof s.exitCode==='number' : s.status==='completed' && s.exitCode===0)),'BLOCKED: no settled real candidate Doctor receipt');
      assert.equal(digest(sourceAsset),cell.source.assetSha256,'Live asset changed');
      assert.equal(digest(path.join(plugin,'index.mjs')),cell.source.pluginSha256,'Plugin source changed');
      assert.equal(fs.readlinkSync(path.join(plugin,'config.txt')),cell.source.link,'Live alias changed');
      const retained = read(env.OPENCLAW_CONFIG_PATH);
      assert.deepEqual(retained.plugins.entries[ID],config.plugins.entries[ID]);
      assert.deepEqual(retained.plugins.load.paths,[plugin]); assert.equal(retained.gateway.controlUi.experimental.customPlugins,false);
      assert.equal(retained.gateway.auth.token,config.gateway.auth.token);
      cell.afterVersion=read(path.join(pkg,'package.json')).version;
      assert.equal(digest(candidate),summary.artifacts.C.sha256,'C tarball changed during update');
      assert.equal(digest(q),summary.artifacts.Q.sha256,'Q tarball changed during update');
      if(name==='failure' || name==='cancel') {
        assert(result.code !== 0 || result.signal,'Failure/cancellation returned success');
        assert(!result.failure,'Harness timeout/log/observer failure is not product failure evidence');
        assert.equal(cell.afterVersion,summary.artifacts.C.version,'Failed preparation activated Q');
        if(name==='failure') assert(text.includes('HOSTED_EXPECTED_FAILURE_AFTER_PRIVATE_WRITE'),'Missing intended fixture failure');
        else assert(cancelled && result.cancellation?.afterPrivateWrite,'Cancellation was not sent after observed private work');
      } else {
        requireOk(result); assert.equal(cell.afterVersion,summary.artifacts.Q.version,'Q not active');
        requireOk(await cli('config-after',['config','validate','--json']));
        requireOk(await cli('doctor-after',['doctor','--lint','--json','--severity-min','error']));
      }
      if(name==='failure') assert.equal(cell.ledger[0].status,'failed','Failure did not settle updater ledger');
      if(name==='cancel') assert.equal(cell.ledger[0].status,'failed','BLOCKED: cancelled updater has not settled its ledger');
      cell.status='passed'; cell.settingsRetained=true; cell.liveSourceUnchanged=true;
    } catch(e) { cell.status=e.message.startsWith('BLOCKED:')?'blocked':'failed'; cell.reason=e.stack || e.message; }
    save();
  }
  if((options.runtimes || 'auto')==='auto' && !bun) summary.cells.push({name:'bun-runtime',runtime:'bun',status:'blocked',reason:'Bun not installed; no substitution/download performed'});
  summary.status=summary.cells.every(c=>c.status==='passed')?'passed':summary.cells.some(c=>c.status==='failed')?'failed':'partial';
} catch(e) { summary.status='blocked'; summary.reason=e.stack || e.message; }
summary.finishedAt=new Date().toISOString(); save(); console.log(JSON.stringify(summary,null,2));
process.exitCode=summary.status==='passed'?0:summary.status==='partial'?2:1;
