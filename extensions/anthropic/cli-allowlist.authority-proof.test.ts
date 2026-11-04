import { execFileSync } from "node:child_process";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { formatErrorMessageForDisplay } from "openclaw/plugin-sdk/error-runtime";
import path from "node:path";
import * as processRuntime from "openclaw/plugin-sdk/process-runtime";
import * as tempPath from "openclaw/plugin-sdk/temp-path";
import { afterEach, expect, it, vi } from "vitest";
import { closePluginTestAdmissions, createExecution } from "../../src/agents/cli-runner/execute-plugin.test-support.js";
import { executePluginOwnedProcess } from "../../src/agents/cli-runner/execute-plugin.js";
import { executeClaudeCli } from "./cli.runtime.js";
import { createClaudeCliTransport } from "./cli-transport.js";
import { CLAUDE_RESTRICTED_SETTINGS } from "./cli-shared.js";
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
  admitted={behavior:decision.behavior,message:decision.message,content:decision.behavior==="allow"?readFileSync(decision.updatedInput.file_path,"utf8"):undefined};
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

function runProbe(context: Awaited<ReturnType<typeof createExecution>>["context"], probe: Awaited<ReturnType<typeof harness.context>>, records: Record<string,unknown>[] = []) {
 context.params.cliToolAvailability = {native:["Read"],openClaw:tools.map(name=>name.slice("mcp__openclaw__".length))};
 return executePluginOwnedProcess({context:{...context,cwd:probe.cwd,workspaceDir:probe.cwd},execute:executeClaudeCli,
  executionCommand:probe.command,executionArgs:[...probe.args,"--settings","{}","--allowedTools",tools.join(","),"--tools","Read","--disallowedTools","Write,Bash"],
  env:probe.env,prompt:probe.prompt,useResume:false,noOutputTimeoutMs:60000,consumeStdout:chunk=>records.push(JSON.parse(chunk))});
}

it("retains real host policy at admitted Read and nearest-forbidden Write effects after relocation", async()=>{
 // Native Read follows the existing exec approval policy; full/off admits the
 // declared Read, while availability still forbids undeclared Write and Bash.
 const {context}=await createExecution({nativeTools:["Read"],timeoutMs:60000});
 const probe=await harness.context(fixture,{timeoutMs:60000,abortSignal:AbortSignal.timeout(60000)});
 await writeFile(path.join(probe.cwd,"admitted.txt"),"synthetic admitted content");
 if(hostPlatform!=="win32") injectWindowsLimit();
 const records:Record<string,unknown>[]=[];
 const exit=await runProbe(context,probe,records);
 const result=resultDetail(records);
 expect(result).toMatchObject({admitted:{behavior:"allow",content:"synthetic admitted content"},forbidden:{behavior:"deny"},allow:tools});
 await expect(access(path.join(probe.cwd,"forbidden.txt"))).rejects.toThrow();
 expect(exit).toMatchObject({reason:"exit",exitCode:0});
 console.log(JSON.stringify({scenario:"relocated-host-policy",admittedRead:"allowed and read real file",forbiddenWrite:"denied; file absent",admittedMcpNames:tools.length,exactSettings:true}));
},120000);

it.skipIf(hostPlatform !== "win32")("real Claude consumes exactly the relocated grants and retains explicit denials without model credentials", async()=>{
 const context=await harness.context("",{timeoutMs:180000,abortSignal:AbortSignal.timeout(180000)});
 for(const name of ["SystemRoot","SYSTEMROOT","ComSpec","COMSPEC","PATHEXT"]) {
  if(process.env[name]) context.env[name]=process.env[name]!;
 }
 Object.assign(context.env,{USERPROFILE:context.cwd,TEMP:context.cwd,TMP:context.cwd,
  APPDATA:path.join(context.cwd,"AppData/Roaming"),LOCALAPPDATA:path.join(context.cwd,"AppData/Local"),CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS:"1"});
 await mkdir(context.env.APPDATA!,{recursive:true});await mkdir(context.env.LOCALAPPDATA!,{recursive:true});
 const npm=path.join(path.dirname(process.execPath),"node_modules/npm/bin/npm-cli.js");
 await access(npm);
 execFileSync(process.execPath,[npm,"install","--prefix",context.cwd,"--ignore-scripts","--no-package-lock","--omit=dev","@anthropic-ai/claude-code@2.1.280"],{timeout:180000,stdio:"pipe"});
 const packageRoot=path.join(context.cwd,"node_modules/@anthropic-ai/claude-code");
 const metadata=JSON.parse(await readFile(path.join(packageRoot,"package.json"),"utf8"));
 const entry=path.join(packageRoot,typeof metadata.bin === "string" ? metadata.bin : metadata.bin.claude);
 context.args=[entry,"--print","--input-format","stream-json","--output-format","stream-json","--verbose","--permission-prompt-tool","stdio","--permission-mode","default","--setting-sources","","--no-session-persistence","--strict-mcp-config","--mcp-config",'{"mcpServers":{}}',"--settings",JSON.stringify(CLAUDE_RESTRICTED_SETTINGS),"--allowedTools",tools.join(","),"--tools","Read","--disallowedTools","Write,Bash"];
 let resolveRules:(value:unknown)=>void;
 let rejectRules:(error:unknown)=>void;
 const rules=new Promise<unknown>((resolve,reject)=>{resolveRules=resolve;rejectRules=reject;});
 void rules.catch(()=>{});
 let settingsFile:string|undefined;
 const owned=processRuntime.createOwnedStdioProcess;
 vi.spyOn(processRuntime,"createOwnedStdioProcess").mockImplementation(async options=>{
  const child=await owned(options);
  settingsFile=options.argv[options.argv.lastIndexOf("--settings")+1];
  let pending="";
  return new Proxy(child,{get(target,key){
   if(key!=="onStdout") return Reflect.get(target,key);
   return (callback:Parameters<typeof child.onStdout>[0])=>target.onStdout(async chunk=>{
    pending+=chunk;
    for(;;){const end=pending.indexOf("\n");if(end<0)break;const line=pending.slice(0,end);pending=pending.slice(end+1);
     try {const value=JSON.parse(line);if(value.type==="control_response" && value.response?.request_id==="permission-probe") resolveRules(value.response);}catch{}
    }
    await callback(chunk);
   });
  }});
 });
 const transport=await createClaudeCliTransport({context,args:context.args,initialize:{},currentContext:()=>context,
  onMessage:async()=>{},onRequest:async()=>()=>({behavior:"deny",message:"No model prompt in this probe."}),onError:error=>{
   console.log(JSON.stringify({scenario:"real-claude-startup-diagnostic",message:formatErrorMessageForDisplay(error).replaceAll(context.cwd,"<private-probe>")}));rejectRules(error);
  }});
 try {
  await transport.initialize();
  await transport.send({type:"control_request",request_id:"permission-probe",request:{subtype:"list_permission_rules"}});
  const response=await rules;
  const text=JSON.stringify(response);
  expect(new Set(text.match(/mcp__openclaw__server_\d+__synthetic_action/g))).toEqual(new Set(tools));
  expect(text).not.toContain("mcp__openclaw__*");
  expect(text).toContain("flagSettings");expect(text).toContain('"Write"');expect(text).toContain('"Bash"');
  expect(settingsFile).not.toBe(JSON.stringify(CLAUDE_RESTRICTED_SETTINGS));
  console.log(JSON.stringify({scenario:"real-claude-permission-rules",version:metadata.version,admittedMcpNames:tools.length,exactNames:true,wildcardAdded:false,allowSource:"flagSettings",explicitDenials:["Write","Bash"],modelPrompts:0,modelCredentials:0}));
 } finally {transport.close();await transport.waitForExit();}
 await expect(access(settingsFile!)).rejects.toThrow();
},240000);

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
 const running=runProbe(context,probe);
 await expect(running).rejects.toThrow();
 expect(spawn).toHaveBeenCalledTimes(1);
 await expect(access(path.join(probe.cwd,"child.started"))).rejects.toThrow();
 expect(directory).toBeDefined(); await expect(access(directory!)).rejects.toThrow();
 console.log(JSON.stringify({scenario:"admission-retired-during-write",initialOsFailure:1,retryProcessLaunches:0,childMarker:"absent",settingsWorkspace:"removed"}));
},120000);
