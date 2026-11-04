import { access, writeFile } from "node:fs/promises";
import path from "node:path";
import * as processRuntime from "openclaw/plugin-sdk/process-runtime";
import * as tempPath from "openclaw/plugin-sdk/temp-path";
import { afterEach, expect, it, vi } from "vitest";
import { closePluginTestAdmissions, createExecution, runPlugin } from "../../src/agents/cli-runner/execute-plugin.test-support.js";
import { executeClaudeCli } from "./cli.runtime.js";
import { createCliTestHarness, resultDetail } from "./cli-runtime.test-support.js";

const hostPlatform = process.platform;
const harness = createCliTestHarness("openclaw-156057-authority-");
const tools = Array.from({length: 900}, (_, i) => `mcp__openclaw__server_${i}__synthetic_action`);
const fixture = `
import {readFileSync,writeFileSync} from "node:fs";
import {createInterface} from "node:readline";
writeFileSync("child.started", "started");
const args=process.argv.slice(2);
const settingsPath=args[args.lastIndexOf("--settings")+1];
const settings=JSON.parse(readFileSync(settingsPath,"utf8"));
const send=value=>console.log(JSON.stringify(value));
const ask=(id,name,input)=>send({type:"control_request",request_id:id,request:{subtype:"can_use_tool",tool_name:name,input,tool_use_id:id}});
let admitted;
createInterface({input:process.stdin}).on("line",line=>{
 const message=JSON.parse(line);
 if(message.type==="control_request") send({type:"control_response",response:{subtype:"success",request_id:message.request_id,response:{}}});
 else if(message.type==="user") ask("read","Read",{file_path:process.cwd()+"/admitted.txt"});
 else if(message.type==="control_response" && message.response.request_id==="read") {
  const decision=message.response.response;
  admitted={behavior:decision.behavior,content:decision.behavior==="allow"?readFileSync(decision.updatedInput.file_path,"utf8"):undefined};
  ask("write","Write",{file_path:process.cwd()+"/forbidden.txt",content:"must not be written"});
 } else if(message.type==="control_response" && message.response.request_id==="write") {
  const denied=message.response.response;
  if(denied.behavior==="allow") writeFileSync(denied.updatedInput.file_path,denied.updatedInput.content);
  send({type:"result",subtype:"success",result:JSON.stringify({admitted,forbidden:denied,allow:settings.permissions.allow})});
 }
});
`;

afterEach(async () => { await harness.cleanup(); closePluginTestAdmissions(); vi.restoreAllMocks(); });

function injectWindowsLimit() {
 vi.spyOn(processRuntime,"createOwnedStdioProcess").mockImplementationOnce(async()=>{
  vi.spyOn(process,"platform","get").mockReturnValue(hostPlatform).mockReturnValueOnce("win32");
  throw Object.assign(new Error("spawn ENAMETOOLONG"),{code:"ENAMETOOLONG"});
 });
}

it("retains real host policy at admitted Read and nearest-forbidden Write effects after relocation", async()=>{
 const {context}=await createExecution({nativeTools:["Read"],timeoutMs:60000,config:{tools:{exec:{security:"deny",ask:"off"}}}});
 const probe=await harness.context(fixture,{timeoutMs:60000,abortSignal:AbortSignal.timeout(60000)});
 await writeFile(path.join(probe.cwd,"admitted.txt"),"synthetic admitted content");
 if(hostPlatform!=="win32") injectWindowsLimit();
 const records:Record<string,unknown>[]=[];
 const exit=await runPlugin(context,async function*(execution){
  for await(const record of executeClaudeCli({...probe,requestToolPermission:execution.requestToolPermission,assertCurrent:execution.assertCurrent,
   args:[...probe.args,"--settings","{}","--allowedTools",tools.join(","),"--tools","Read","--disallowedTools","Write,Bash"]})){
   records.push(record); yield record;
  }
 },{noOutputTimeoutMs:60000});
 const result=resultDetail(records);
 expect(result).toMatchObject({admitted:{behavior:"allow",content:"synthetic admitted content"},forbidden:{behavior:"deny"},allow:tools});
 await expect(access(path.join(probe.cwd,"forbidden.txt"))).rejects.toThrow();
 expect(exit).toMatchObject({reason:"exit",exitCode:0});
 console.log(JSON.stringify({scenario:"relocated-host-policy",admittedRead:"allowed and read real file",forbiddenWrite:"denied; file absent",admittedMcpNames:tools.length,exactSettings:true}));
},120000);

it("closes real run admission during the settings write and never starts the retry child", async()=>{
 const {context,admission}=await createExecution({nativeTools:["Read"],timeoutMs:60000});
 const probe=await harness.context(fixture,{timeoutMs:60000,abortSignal:AbortSignal.timeout(60000)});
 injectWindowsLimit();
 const spawn=vi.mocked(processRuntime.createOwnedStdioProcess);
 const workspace=tempPath.tempWorkspace;
 let directory:string|undefined;
 vi.spyOn(tempPath,"tempWorkspace").mockImplementation(async options=>{
  const created=await workspace({...options,rootDir:probe.cwd}); directory=created.dir;
  return {...created,writeJson:async(...args)=>{
   const file=await created.writeJson(...args); admission.close(); return file;
  }};
 });
 const running=runPlugin(context,execution=>executeClaudeCli({...probe,assertCurrent:execution.assertCurrent,
  requestToolPermission:execution.requestToolPermission,args:[...probe.args,"--settings","{}","--allowedTools",tools.join(",")]}),{noOutputTimeoutMs:60000});
 await expect(running).rejects.toThrow();
 expect(spawn).toHaveBeenCalledTimes(1);
 await expect(access(path.join(probe.cwd,"child.started"))).rejects.toThrow();
 expect(directory).toBeDefined(); await expect(access(directory!)).rejects.toThrow();
 console.log(JSON.stringify({scenario:"admission-retired-during-write",initialOsFailure:1,retryProcessLaunches:0,childMarker:"absent",settingsWorkspace:"removed"}));
},120000);
