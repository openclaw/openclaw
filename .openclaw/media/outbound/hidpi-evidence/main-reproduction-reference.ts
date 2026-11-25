import { expect, it } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import { chromium } from "playwright-core";
import { createOpenClawTestInstance } from "../../../test/helpers/openclaw-test-instance.ts";
import { ensureGatewayOwnerProfile } from "../../../src/state/user-profiles.ts";
import { appendTranscriptMessage } from "../../../src/config/sessions/session-accessor.ts";
import { acquireGatewayTestClient } from "../../../test/helpers/gateway-client.ts";
import { getFreePort } from "../../../src/test-utils/ports.ts";

it("reproduces managed HiDPI clicks in the real Files preview", async () => {
const root = process.env.HIDPI_ARTIFACT_ROOT!;
const label = process.env.HIDPI_BUILD_LABEL!;
const results = [];
const css = "body{font:16px system-ui;margin:24px;color:#15283b;background:#fff}h1{font-size:24px}summary{padding:12px;background:#edf3fa;cursor:pointer}details{margin-top:24px}p{line-height:1.6}";
const sessionKey = "agent:main:hidpi-proof";
const html = '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Batch report</title><style>body{font:16px system-ui;margin:24px;color:#15283b;background:#fff}h1{font-size:24px}summary{padding:12px;background:#edf3fa;cursor:pointer}details{margin-top:24px}p{line-height:1.6}</style></head><body><h1>Release QA batch report</h1><p>Workspace HTML preview interaction check</p><details><summary>Batch notes</summary><p id="notes">Batch notes opened by a trusted coordinate click.</p></details></body></html>';
const cspHtml = html.replace(/<style>[\s\S]*?<\/style>/, `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'self'; script-src 'self'"><link rel="stylesheet" href="styles.css">`);
const server = createServer((req,res)=>{res.setHeader("Content-Type",req.url==="/styles.css"?"text/css":"text/html");res.end(req.url==="/styles.css"?css:html);});
server.listen(0,"127.0.0.1");await once(server,"listening");
let browser;
let client;
const cdpPort = await getFreePort();
const instance = await createOpenClawTestInstance({
 name:"hidpi-click-proof",entrypoint:["dist/index.js"],startTimeoutMs:120000,
 env:{FONTCONFIG_FILE:path.join(root,"fonts.conf"),OPENCLAW_TEST_MINIMAL_GATEWAY:undefined,OPENCLAW_SKIP_CANVAS_HOST:"0",OPENCLAW_SKIP_BROWSER_CONTROL_SERVER:"0",VITEST:undefined},
 config:{
  update:{checkOnStart:false},gateway:{controlUi:{enabled:true,embedSandbox:"scripts"}},cron:{enabled:false},
  browser:{enabled:true,headless:true,noSandbox:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,defaultProfile:"openclaw",profiles:{openclaw:{cdpPort}},ssrfPolicy:{allowedHostnames:["127.0.0.1","localhost"]}},
  agents:{ownership:"explicit",defaults:{workspace:"${OPENCLAW_WORKSPACE_DIR}",model:"fixture/unused"},entries:{main:{identity:{name:"QA assistant"}}}},
  models:{catalogRefresh:{enabled:false},providers:{fixture:{api:"openai-responses",apiKey:"synthetic-unused-key",baseUrl:"http://127.0.0.1:9/v1",models:[{id:"unused",name:"Unused fixture model"}]}}},
  plugins:{allow:["browser","openai"]}
 }
});
async function cli(args:string[],quiet=false){
 const result=await instance.cli(args,{timeoutMs:90000});
 if(!quiet) console.log(JSON.stringify({command:args,code:result.code,stdout:result.stdout,stderr:result.stderr}));
 if(result.code!==0) {
  let reason="";
  if(quiet && result.stdout.trim().startsWith("{")) { const failure=JSON.parse(result.stdout); reason=typeof failure.reason==="string"?failure.reason:""; }
  throw new Error("CLI failed: "+args.slice(0,3).join(" ")+" code="+result.code+" signal="+result.signal+" "+reason+" "+result.stderr);
 }
 return result.stdout;
}
try {
 const workspace=instance.state.path("workspace");
 instance.env.OPENCLAW_WORKSPACE_DIR=workspace;
 instance.env.OPENCLAW_GATEWAY_PORT=String(instance.port);
 await mkdir(workspace,{recursive:true});
 for(const [file,content] of Object.entries({"batch.html":html,"csp-batch.html":cspHtml,"styles.css":css})) await writeFile(path.join(workspace,file),content);
 ensureGatewayOwnerProfile("QA operator",{env:instance.env});
 console.log("Starting isolated real Gateway");
 await instance.startGateway();
 console.log("Gateway ready");
 client=await acquireGatewayTestClient({url:instance.url,token:instance.gatewayToken,env:instance.env,clientName:"cli",mode:"cli",scopes:["operator.admin"],deviceIdentity:null,deviceAuthScope:instance.url,sharedStateMode:"read-only"},{timeoutMs:15000,timeoutMessage:"Gateway connection timeout",closeMessage:"Gateway closed"});
 const session=await client.request<{sessionId:string}>("sessions.create",{key:sessionKey,agentId:"main",cwd:workspace,label:"HiDPI preview QA",permissionMode:"read-only"});
 await appendTranscriptMessage({agentId:"main",sessionKey,sessionId:session.sessionId,env:instance.env},{message:{role:"assistant",content:[{type:"text",text:"Open [Batch report](batch.html) or [CSP batch report](csp-batch.html) to inspect the release notes."}]},timestamp:Date.now()});
 await cli(["browser","start","--headless"]);
 browser=await chromium.connectOverCDP("http://127.0.0.1:"+cdpPort);
 let context=browser.contexts()[0];
 let page=context.pages()[0]??await context.newPage();
 page.setDefaultTimeout(45000);
 const handoff=JSON.parse(await cli(["dashboard","--json"],true));
 await page.goto(handoff.browserUrl);
 await page.waitForFunction(()=>window.openclawControlUi?.snapshot().gatewayPhase==="connected");
 await page.goto("http://127.0.0.1:"+instance.port+"/chat/main/~key/hidpi-proof");

 let cdp=await context.newCDPSession(page);
 const targetId=(await cdp.send("Target.getTargetInfo")).targetInfo.targetId;
 console.log("BUILD "+JSON.stringify({label,browser:browser.version()}));
 const capture=async(name)=>{
  const {data}=await cdp.send("Page.captureScreenshot",{format:"png",fromSurface:true,captureBeyondViewport:false});
  await writeFile(path.join(root,label+"-"+name+".png"),Buffer.from(data,"base64"));
 };
 const observe=async(document,scenario,device,trial,exact)=>{
  await document.locator("details").evaluate(e=>{e.open=false;window.events=[];if(!window.recording){window.recording=true;for(const type of ["mousedown","mouseup","click"])document.addEventListener(type,e=>window.events.push({type:e.type,x:e.clientX,y:e.clientY,target:e.target.tagName,trusted:e.isTrusted}));}});
  const before=await page.evaluate(()=>({dpr:devicePixelRatio,width:innerWidth,height:innerHeight}));
  expect(before.dpr).toBe(device.includes("HiDPI")?2:1);
  const box=await document.locator("summary").boundingBox();expect(box).toBeTruthy();
  const x=exact?896:Math.round(box.x+70),y=exact?216:Math.round(box.y+box.height/2);
  expect(x>=box.x&&x<box.x+box.width&&y>=box.y&&y<box.y+box.height,"Click must be inside the measured summary").toBe(true);
  const name=scenario+"-"+(device.includes("HiDPI")?"2x":"1x")+"-"+trial;
  if(device.includes("HiDPI")&&trial===1)await capture(name+"-before");
  await cli(["browser","click-coords",String(x),String(y),"--target-id",targetId]);
  const observation={label,scenario,device,trial,coordinates:{x,y},box,before,after:await page.evaluate(()=>({dpr:devicePixelRatio,width:innerWidth,height:innerHeight})),inner:await document.locator("body").evaluate(()=>({dpr:devicePixelRatio,open:document.querySelector("details").open,events:window.events}))};
  results.push(observation);
  console.log("OBSERVATION "+JSON.stringify(observation));
  await writeFile(path.join(root,label+"-results.json"),JSON.stringify(results,null,2));
  if(device.includes("HiDPI")&&trial===1)await capture(name+"-after");
  expect.soft(observation.after.dpr).toBe(before.dpr);
  expect.soft(observation.inner.open,scenario+" "+device+" trial "+trial).toBe(true);
 };
 for(const [file,scenario] of [["batch.html","plain-preview"],["csp-batch.html","csp-preview"]]){
  await page.locator('a.markdown-file-link[data-file-path="'+file+'"]').click();
  const panel=page.locator("openclaw-chat-detail-panel:visible");
  const document=panel.locator(".chat-html-preview__frame").contentFrame().frameLocator("iframe");
  await document.getByText("Batch notes",{exact:true}).waitFor();
  for(const device of ["Desktop Chrome","Desktop Chrome HiDPI"]){
   await cli(["browser","set","device",device,"--target-id",targetId]);
   for(const trial of [1,2])await observe(document,scenario,device,trial,scenario==="plain-preview");
  }
 }

 await page.locator('a.markdown-file-link[data-file-path="batch.html"]').click();
 for(const trial of [1,2]){
  const doc=page.locator("openclaw-chat-detail-panel:visible .chat-html-preview__frame").contentFrame().frameLocator("iframe");
  await doc.getByText("Batch notes",{exact:true}).waitFor();
  await doc.locator("details").evaluate(e=>{e.open=false;window.events=[];});
  const box=await doc.locator("summary").boundingBox();
  await cdp.detach();
  await browser.close();browser=undefined;
  await cli(["browser","set","device","Desktop Chrome","--target-id",targetId]);
  await cli(["browser","set","device","Desktop Chrome HiDPI","--target-id",targetId]);
  const before=JSON.parse(await cli(["browser","evaluate","--fn","() => devicePixelRatio","--target-id",targetId,"--json"]));
  expect(before.result).toBe(2);
  await cli(["browser","click-coords","896","216","--target-id",targetId]);
  const after=JSON.parse(await cli(["browser","evaluate","--fn","() => devicePixelRatio","--target-id",targetId,"--json"]));
  expect(after.result).toBe(2);
  browser=await chromium.connectOverCDP("http://127.0.0.1:"+cdpPort);
  context=browser.contexts()[0];page=context.pages().find(p=>p.url().includes("hidpi-proof"))!;
  cdp=await context.newCDPSession(page);
  const inner=await page.locator("openclaw-chat-detail-panel:visible .chat-html-preview__frame").contentFrame().frameLocator("iframe").locator("body").evaluate(()=>({open:document.querySelector("details").open,events:window.events}));
  const observation={label,scenario:"CLI-only-plain-preview",device:"Desktop Chrome HiDPI",trial,coordinates:{x:896,y:216},box,before:{dpr:before.result},after:{dpr:after.result},inner};
  results.push(observation);console.log("OBSERVATION "+JSON.stringify(observation));
  await writeFile(path.join(root,label+"-results.json"),JSON.stringify(results,null,2));
  expect.soft(inner.open,"CLI-only trial "+trial).toBe(true);
 }
 const address=server.address();
 await cli(["browser","navigate","http://127.0.0.1:"+address.port+"/batch.html","--target-id",targetId]);
 await page.getByText("Batch notes",{exact:true}).waitFor();
 for(const trial of [1,2])await observe(page,"direct-html","Desktop Chrome HiDPI",trial,false);
 await cdp.detach();
} catch(error){
 await writeFile(path.join(root,label+"-gateway.log"),instance.logs());
 throw error;
} finally {
 await browser?.close().catch(()=>{});
 await client?.stopAndWait().catch(()=>{});
 await instance.cleanup();
 await new Promise<void>(resolve=>server.close(()=>resolve()));
 console.log("CLEANUP isolated Gateway state/processes retired");
}

}, 360000);
