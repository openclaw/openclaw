// Scaffold checks ONLY. This is intentionally not a product/updater proof.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { ID, ORIGINAL, PRIVATE, SETTINGS, pluginSource } from './fixture.mjs';
const root=fs.mkdtempSync(path.join(path.dirname(fileURLToPath(import.meta.url)),'.self-test-'));
const outcomes=[];
for(const name of ['success','failure','symlink-negative','settings-negative']) {
  const base=path.join(root,name),live=path.join(base,'live'),state=path.join(base,'private'),plugin=path.join(state,'plugin');
  fs.mkdirSync(plugin,{recursive:true}); fs.mkdirSync(live);
  const sourceAsset=path.join(live,'config.txt'); fs.writeFileSync(sourceAsset,ORIGINAL);
  fs.writeFileSync(path.join(plugin,'config.txt'),ORIGINAL);
  fs.writeFileSync(path.join(plugin,'second.txt'),ORIGINAL);
  if(name==='symlink-negative') { fs.unlinkSync(path.join(plugin,'config.txt')); fs.symlinkSync(sourceAsset,path.join(plugin,'config.txt')); }
  const entry=path.join(plugin,'index.mjs'); fs.writeFileSync(entry,pluginSource({liveState:live,sourceAsset,mode:name}));
  const syntax=spawnSync(process.execPath,['--check',entry],{encoding:'utf8'}); assert.equal(syntax.status,0,syntax.stderr);
  const mod=await import(pathToFileURL(entry).href);
  const previous=process.env.OPENCLAW_STATE_DIR; process.env.OPENCLAW_STATE_DIR=state;
  let error;
  if(name==='failure') {
    const code='const m=await import('+JSON.stringify(pathToFileURL(entry).href)+');m.default.register('+JSON.stringify({rootDir:plugin,pluginConfig:SETTINGS})+');';
    const child=spawnSync(process.execPath,['--input-type=module','-e',code],{encoding:'utf8',env:{...process.env,OPENCLAW_STATE_DIR:state}});
    assert.equal(child.status,42); assert.match(child.stderr,/HOSTED_EXPECTED_FAILURE_AFTER_PRIVATE_WRITE/);
  } else {
    try { mod.default.register({rootDir:plugin,pluginConfig:name==='settings-negative'?{}:SETTINGS}); } catch(e) { error=e; }
  }
  if(previous===undefined) delete process.env.OPENCLAW_STATE_DIR; else process.env.OPENCLAW_STATE_DIR=previous;
  assert.equal(fs.readFileSync(sourceAsset,'utf8'),ORIGINAL);
  if(name==='success' || name==='failure') {
    assert.equal(fs.readFileSync(path.join(plugin,'config.txt'),'utf8'),PRIVATE);
    assert.equal(JSON.parse(fs.readFileSync(path.join(state,'hosted-proof-private.json'))).kind,'private-register-write');
  }
  if(name==='success') assert.equal(error,undefined);

  if(name==='symlink-negative') assert.match(error.message,/still a symlink/);
  if(name==='settings-negative') assert.match(error.message,/settings were not retained/);
  outcomes.push({name,status:'passed'});
}
const sqlite=path.join(root,'receipt.sqlite'),db=new DatabaseSync(sqlite);
db.exec('CREATE TABLE update_runs(run_id TEXT,created_at_ms INTEGER,status TEXT,phase TEXT,reason TEXT,target_json TEXT,steps_json TEXT,verification_json TEXT)');
db.prepare('INSERT INTO update_runs VALUES(?,?,?,?,?,?,?,?)').run('synthetic',1,'failed','finished','fixture','{}','[]','{}'); db.close();
const ledger=spawnSync(process.execPath,[fileURLToPath(new URL('./ledger.mjs',import.meta.url)),sqlite],{encoding:'utf8'});
assert.equal(ledger.status,0,ledger.stderr); assert.equal(JSON.parse(ledger.stdout)[0].run_id,'synthetic');
outcomes.push({name:'read-only-ledger-scaffold',status:'passed'});
const result={scope:'harness-scaffold-only-not-product-proof',root,outcomes};
fs.writeFileSync(path.join(root,'result.json'),JSON.stringify(result,null,2)); console.log(JSON.stringify(result,null,2));
