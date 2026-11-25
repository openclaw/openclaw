import { expect, it } from "vitest";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import { createRequire } from "node:module";
import { WebSocket } from "ws";
import { createOpenClawTestInstance } from "../../../test/helpers/openclaw-test-instance.ts";
import { ensureGatewayOwnerProfile } from "../../../src/state/user-profiles.ts";
import { appendTranscriptMessage } from "../../../src/config/sessions/session-accessor.ts";
import { acquireGatewayTestClient } from "../../../test/helpers/gateway-client.ts";
import { getFreePort } from "../../../src/test-utils/ports.ts";
import { createImageProcessor } from "../../../src/media/image-ops.ts";

const root = process.env.HIDPI_ARTIFACT_ROOT!;
const label = process.env.HIDPI_BUILD_LABEL!;
const require = createRequire(import.meta.url);
const { PNG } = require(path.resolve("node_modules/.pnpm/pngjs@7.0.0/node_modules/pngjs"));
const html = `<!doctype html><meta charset="utf-8"><title>Packing slip</title>
<h1>Packing slip</h1><p>Inspect the highlighted row.</p>
<details><summary style="background:rgb(231,162,59);padding:8px;width:160px">Batch notes</summary>
<p style="background:rgb(40,177,92);padding:10px;width:165px">Six boxes of winter pears.</p></details>
`;

class Observer {
  socket: WebSocket;
  serial = 0;
  pending = new Map();
  contexts = new Map();
  sessions = new Map();
  constructor(url: string) {
    this.socket = new WebSocket(url);
    this.socket.on("message", raw => {
      const message = JSON.parse(raw.toString());
      if (message.id) {
        const waiting = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) waiting?.reject(new Error(message.error.message));
        else waiting?.resolve(message.result);
      } else if (message.method === "Runtime.executionContextCreated") {
        const context = message.params.context;
        if (context.auxData?.isDefault) this.contexts.set(message.sessionId+":"+context.id, {sessionId:message.sessionId,id:context.id});
      } else if (message.method === "Runtime.executionContextDestroyed") {
        this.contexts.delete(message.sessionId+":"+message.params.executionContextId);
      }
    });
  }
  async send(method: string, params = {}, sessionId?: string) {
    const id = ++this.serial;
    return await new Promise<any>((resolve,reject)=>{
      this.pending.set(id,{resolve,reject});
      this.socket.send(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})}));
    });
  }
  async findDocument(targetId: string) {
    for(let attempt=0;attempt<30;attempt++){
      const {targetInfos}=await this.send("Target.getTargets");
      for(const target of targetInfos.filter(t=>t.targetId===targetId||t.type==="iframe")){
        if(!this.sessions.has(target.targetId)){
          const {sessionId}=await this.send("Target.attachToTarget",{targetId:target.targetId,flatten:true});
          this.sessions.set(target.targetId,sessionId);
          await this.send("Runtime.enable",{},sessionId);
        }
      }
      for(const context of this.contexts.values()){
        try {
          const answer=await this.evaluate(context,'document.querySelector("summary")?.textContent');
          if(answer==="Batch notes") return context;
        } catch {}
      }
      await new Promise(resolve=>setTimeout(resolve,100));
    }
    throw new Error("Embedded packing-slip document did not become available");
  }
  async evaluate(context, expression: string) {
    const result=await this.send("Runtime.evaluate",{contextId:context.id,expression,returnByValue:true,awaitPromise:true},context.sessionId);
    if(result.exceptionDetails) throw new Error(result.exceptionDetails.text);
    return result.result.value;
  }
  async close(){this.socket.close();await once(this.socket,"close");}
}

it.each([1,2])("observes the Chrome 159 same-tab QA sequence with fresh state, attempt %s", async attempt=>{
  const name=label+"-"+attempt;
  const record:any={build:label,attempt,architecture:process.arch,browserVersion:"159.0.8154.6",directUrlScheme:"http",sequence:[]};
  const server=createServer((req,res)=>{res.setHeader("Content-Type","text/html; charset=utf-8");res.end(html);});
  server.listen(0,"127.0.0.1");await once(server,"listening");
  const cdpPort=await getFreePort();
  const instance=await createOpenClawTestInstance({
    name:"hidpi159-"+attempt,entrypoint:["dist/index.js"],startTimeoutMs:120000,
    env:{FONTCONFIG_FILE:path.join(root,"fonts.conf"),OPENCLAW_TEST_MINIMAL_GATEWAY:undefined,OPENCLAW_SKIP_CANVAS_HOST:"0",OPENCLAW_SKIP_BROWSER_CONTROL_SERVER:"0",VITEST:undefined},
    config:{
      update:{checkOnStart:false},gateway:{controlUi:{enabled:true,embedSandbox:"scripts"}},cron:{enabled:false},
      browser:{enabled:true,headless:true,noSandbox:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,defaultProfile:"openclaw",profiles:{openclaw:{cdpPort}},ssrfPolicy:{allowedHostnames:["127.0.0.1","localhost"]}},
      agents:{ownership:"explicit",defaults:{workspace:"${OPENCLAW_WORKSPACE_DIR}",model:"fixture/unused"},entries:{main:{identity:{name:"QA assistant"}}}},
      models:{catalogRefresh:{enabled:false},providers:{fixture:{api:"openai-responses",apiKey:"synthetic-unused-key",baseUrl:"http://127.0.0.1:9/v1",models:[{id:"unused",name:"Unused fixture model"}]}}},
      plugins:{allow:["browser","openai"]}
    }
  });
  let client;
  let observer;
  async function cli(args:string[],quiet=false){
    const result=await instance.cli(args,{timeoutMs:90000});
    if(!quiet)console.log(JSON.stringify({command:args,code:result.code,signal:result.signal,stdout:result.stdout,stderr:result.stderr}));
    if(result.code!==0)throw new Error("CLI failed: "+args.slice(0,2).join(" ")+" code="+result.code+" signal="+result.signal+(quiet?"":(" "+result.stderr)));
    return result.stdout;
  }
  async function json(args:string[],quiet=false){return JSON.parse(await cli([...args,"--json"],quiet));}
  let targetId;
  async function metrics(){
    const r=await json(["browser","evaluate","--fn","() => [innerWidth,innerHeight,devicePixelRatio]","--target-id",targetId]);
    return r.result;
  }
  async function capture(stage:string){
    const r=await json(["browser","screenshot",targetId,"--type","png"]);
    const bytes=await readFile(r.path);
    await writeFile(path.join(root,name+"-"+stage+path.extname(r.path)),bytes);
    const png=(await createImageProcessor().encode(bytes,{format:"png"})).data;
    const image=PNG.sync.read(png);
    const file=name+"-"+stage+".png";
    await writeFile(path.join(root,file),png);
    const {width,height,data}=image;
    let left=width,top=height,right=-1,bottom=-1,count=0;
    for(let y=0;y<height;y++)for(let x=Math.floor(stage.startsWith("direct")?0:width*.6);x<width;x++){
      const i=(y*width+x)*4;
      if(Math.abs(data[i]-231)<=8&&Math.abs(data[i+1]-162)<=8&&Math.abs(data[i+2]-59)<=8){
        left=Math.min(left,x);right=Math.max(right,x);top=Math.min(top,y);bottom=Math.max(bottom,y);count++;
      }
    }
    const result={file,width,height,orangePixels:count,pixelBounds:{left,top,right,bottom},cssBounds:{left:left*1280/width,top:top*720/height,right:(right+1)*1280/width,bottom:(bottom+1)*720/height}};
    console.log("CAPTURE "+JSON.stringify(result));
    return result;
  }
  try {
    const workspace=instance.state.path("workspace");
    instance.env.OPENCLAW_WORKSPACE_DIR=workspace;instance.env.OPENCLAW_GATEWAY_PORT=String(instance.port);
    await mkdir(workspace,{recursive:true});await writeFile(path.join(workspace,"packing-slip.html"),html);
    ensureGatewayOwnerProfile("QA operator",{env:instance.env});
    await instance.startGateway();
    client=await acquireGatewayTestClient({url:instance.url,token:instance.gatewayToken,env:instance.env,clientName:"cli",mode:"cli",scopes:["operator.admin"],deviceIdentity:null,deviceAuthScope:instance.url,sharedStateMode:"read-only"},{timeoutMs:15000,timeoutMessage:"Gateway connection timeout",closeMessage:"Gateway closed"});
    const sessionKey="agent:main:hidpi159-proof";
    const session=await client.request("sessions.create",{key:sessionKey,agentId:"main",cwd:workspace,label:"Packing slip QA",permissionMode:"read-only"});
    await appendTranscriptMessage({agentId:"main",sessionKey,sessionId:session.sessionId,env:instance.env},{message:{role:"assistant",content:[{type:"text",text:"[Open the orchard report](packing-slip.html)"}]},timestamp:Date.now()});
    await cli(["browser","start","--headless"]);
    const opened=await json(["browser","open","http://127.0.0.1:"+server.address().port+"/packing-slip.html"]);
    targetId=opened.targetId;
    expect(typeof targetId).toBe("string");
    record.sequence.push("start -> open direct file in target tab");
    await cli(["browser","set","device","Desktop Chrome HiDPI","--target-id",targetId]);
    record.directMetrics=await metrics();expect(record.directMetrics).toEqual([1280,720,2]);
    record.sequence.push("set Desktop Chrome HiDPI before any chat navigation");
    record.directScreenshot=await capture("direct-before");
    expect([record.directScreenshot.width,record.directScreenshot.height]).toEqual([2000,1125]);
    expect(await metrics()).toEqual([1280,720,2]);
    await cli(["browser","click-coords","96","131","--target-id",targetId]);
    record.directControl=(await json(["browser","evaluate","--fn","() => document.querySelector('details').open","--target-id",targetId])).result;
    expect(record.directControl).toBe(true);
    record.sequence.push("direct click 96,131 opened details");
    const handoff=await json(["dashboard"],true);
    await cli(["browser","navigate",handoff.browserUrl,"--target-id",targetId],true);
    await cli(["browser","wait","--fn","() => window.openclawControlUi?.snapshot().gatewayPhase === 'connected'","--target-id",targetId],true);
    const chatUrl="http://127.0.0.1:"+instance.port+"/chat/main/~key/hidpi159-proof";
    await cli(["browser","navigate",chatUrl,"--target-id",targetId]);
    await cli(["browser","wait","--text","Open the orchard report","--target-id",targetId,"--timeout-ms","45000"]);
    record.sequence.push("navigate the same target tab to the real chat");
    const snapshot=await json(["browser","snapshot","--format","ai","--target-id",targetId]);
    const ref=Object.entries(snapshot.refs??{}).find(([,facts]:any)=>facts.name==="Open the orchard report")?.[0]??snapshot.snapshot.match(/link "Open the orchard report" \[ref=([^\]]+)\]/)?.[1];
    expect(ref).toBeTruthy();
    await cli(["browser","click",ref,"--target-id",targetId]);
    await cli(["browser","wait","openclaw-chat-html-preview iframe","--target-id",targetId,"--timeout-ms","45000"]);
    record.sequence.push("snapshot ref -> Open the orchard report -> Files preview");
    record.previewMetrics=await metrics();expect(record.previewMetrics).toEqual([1280,720,2]);
    const version=await fetch("http://127.0.0.1:"+cdpPort+"/json/version").then(r=>r.json());
    record.browserIdentity=version.Browser;
    observer=new Observer(version.webSocketDebuggerUrl);await once(observer.socket,"open");
    const document=await observer.findDocument(targetId);
    await observer.evaluate(document,'window.__qaEvents=[];for(const type of ["pointerdown","pointerup","click"])document.addEventListener(type,e=>window.__qaEvents.push({type:e.type,x:e.clientX,y:e.clientY,target:e.target.tagName,trusted:e.isTrusted}));true');
    const readState='(()=>{const el=document.querySelector("summary"),r=el.getBoundingClientRect();return {open:document.querySelector("details").open,events:window.__qaEvents,dpr:devicePixelRatio,localBounds:{x:r.x,y:r.y,width:r.width,height:r.height}}})()';
    record.previewBefore=await observer.evaluate(document,readState);
    expect(record.previewBefore.open).toBe(false);
    record.previewBeforeScreenshot=await capture("preview-before");
    const b=record.previewBeforeScreenshot.cssBounds;
    expect(b.left<=896&&896<b.right&&b.top<=216&&216<b.bottom,"896,216 must be on the orange summary in the actual screenshot").toBe(true);
    await cli(["browser","click-coords","896","216","--target-id",targetId]);
    await new Promise(resolve=>setTimeout(resolve,500));
    record.previewAfter=await observer.evaluate(document,readState);
    record.previewAfterMetrics=await metrics();expect(record.previewAfterMetrics).toEqual([1280,720,2]);
    record.previewAfterScreenshot=await capture("preview-after");
    record.sequence.push("click 896,216 returned exit 0; inspected state and native pointer events");
    record.reproduced=record.directControl===true&&record.previewAfter.open===false&&record.previewAfter.events.length===0;
    if(record.reproduced){
      await observer.evaluate(document,'document.querySelector("summary").focus();true');
      await cli(["browser","press","Enter","--target-id",targetId]);
      record.keyboardControl=await observer.evaluate(document,readState);
      expect(record.keyboardControl.open).toBe(true);
      record.keyboardScreenshot=await capture("keyboard-control");
    }
    console.log("RESULT "+JSON.stringify(record));
  } catch(error){
    record.error=String(error);await writeFile(path.join(root,name+"-gateway.log"),instance.logs());throw error;
  } finally {
    await writeFile(path.join(root,name+"-result.json"),JSON.stringify(record,null,2));
    await observer?.close().catch(()=>{});
    await client?.stopAndWait().catch(()=>{});
    await instance.cleanup();
    await new Promise<void>(resolve=>server.close(()=>resolve()));
    console.log("CLEANUP "+name+" Gateway, browser, HTTP server and fresh state retired");
  }
},360000);
