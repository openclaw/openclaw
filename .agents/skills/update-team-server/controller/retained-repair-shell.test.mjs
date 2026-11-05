import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import { join } from "node:path";
const source=readFileSync(join(import.meta.dirname,"openclaw-release-deploy"),"utf8");
function owner(name){const d=[...source.matchAll(/^([a-zA-Z_][a-zA-Z_0-9]*)\(\) \{/gm)],i=d.findIndex(v=>v[1]===name);assert(i>=0,name);return source.slice(d[i].index,d[i+1]?.index??source.length);}
function run(script,env={}){return spawnSync("bash",["-c",script],{encoding:"utf8",env:{PATH:"/usr/bin:/bin",...env}});}
const journal={path:"/fixture/journal/activation.json",device:1,inode:2,sha256:"a".repeat(64)},receipt={path:"/fixture/journal/repair.acceptance-receipt.json",device:1,inode:3,sha256:"b".repeat(64)};
for(const status of ["VERIFIED","READY"]){test(`typed shell bridge ${status} consumes only the exact receipt`,()=>{
 const setup=`set -euo pipefail
node_bin=${JSON.stringify(process.execPath)}
repair_journal=$JOURNAL
repair_context=$CONTEXT
candidate_release=/fixture/C
candidate_info=info
wait_for_live(){ [[ "$*" == "/fixture/C info system 123 456 $JOURNAL" ]] || return 6; }
retained_acceptance(){ [[ "$1:$2" == "check:$JOURNAL" ]] || return 7; printf "%s" "$ACCEPTANCE"; }
repair_step(){ [[ "$1" == verify ]] || return 8; printf "%s" "$2"; }
`;
 const result=run(setup+owner("repair_value")+owner("retained_acceptance_field")+owner("verify_retained_repair_acceptance")+"verify_retained_repair_acceptance",{JOURNAL:JSON.stringify(journal),CONTEXT:JSON.stringify({record:{lifecycle:{started:{process:{pid:123,generation:"456"}}}}}),ACCEPTANCE:JSON.stringify({status,receipt})});
 if(status==="VERIFIED"){assert.equal(result.status,0,result.stderr);assert.deepEqual(JSON.parse(result.stdout),{acceptance:receipt});}else {assert.notEqual(result.status,0);assert.equal(result.stdout,"");}
});}
test("retained shell exit records observation without terminalizing or old rollback",()=>{
 const script=`set -euo pipefail
mode=retained-repair
repair_journal=$JOURNAL
repair_step(){ [[ "$1" == observe-failure ]] || exit 88; printf "%s %s" "$1" "$2"; }
`+owner("on_exit")+"trap on_exit EXIT; exit 73";
 const r=run(script,{JOURNAL:JSON.stringify(journal)});assert.equal(r.status,73);assert.equal(r.stdout,'observe-failure {"code":73}');
});
