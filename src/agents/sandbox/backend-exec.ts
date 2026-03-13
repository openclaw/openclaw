import { buildDockerExecArgs, type BashSandboxConfig } from "../bash-tools.shared.js";

export type SandboxExecInvocation = {
  argv: string[];
  env: NodeJS.ProcessEnv;
  backendId: "exec-sandbox" | "exec-sandbox-opensandbox";
};

export function buildSandboxExecInvocation(params: {
  sandbox: BashSandboxConfig;
  command: string;
  workdir?: string;
  env: Record<string, string>;
  tty: boolean;
}): SandboxExecInvocation {
  const backendKind = params.sandbox.backendKind ?? "docker";
  if (backendKind === "docker") {
    return {
      argv: [
        "docker",
        ...buildDockerExecArgs({
          containerName: params.sandbox.containerName,
          command: params.command,
          workdir: params.workdir,
          env: params.env,
          tty: params.tty,
        }),
      ],
      env: process.env,
      backendId: "exec-sandbox",
    };
  }

  const baseUrl = params.sandbox.opensandboxBaseUrl?.trim();
  if (!baseUrl) {
    throw new Error(
      'Sandbox backend "opensandbox" requires OPEN_SANDBOX_EXECD_URL (or sandbox.opensandboxBaseUrl) to be set.',
    );
  }
  const accessToken = params.sandbox.opensandboxAccessToken?.trim();
  if (!accessToken) {
    throw new Error(
      'Sandbox backend "opensandbox" requires OPEN_SANDBOX_EXECD_ACCESS_TOKEN (or sandbox.opensandboxAccessToken) to be set.',
    );
  }

  const timeoutSec =
    typeof params.sandbox.opensandboxTimeoutSec === "number" &&
    params.sandbox.opensandboxTimeoutSec > 0
      ? Math.floor(params.sandbox.opensandboxTimeoutSec)
      : 1800;
  const envJson = JSON.stringify(params.env ?? {});
  const script = [
    "const base=(process.env.OPENCLAW_OPENSANDBOX_BASE_URL||'').replace(/\\/$/,'');",
    "const token=process.env.OPENCLAW_OPENSANDBOX_ACCESS_TOKEN||'';",
    "const command=process.env.OPENCLAW_OPENSANDBOX_COMMAND||'';",
    "const workdir=process.env.OPENCLAW_OPENSANDBOX_WORKDIR||'/workspace';",
    "const envJson=process.env.OPENCLAW_OPENSANDBOX_ENV_JSON||'{}';",
    "const timeoutRaw=process.env.OPENCLAW_OPENSANDBOX_TIMEOUT_SEC||'1800';",
    "const timeout=Number.parseInt(timeoutRaw,10);",
    "if(!base){console.error('OPENCLAW_OPENSANDBOX_BASE_URL is required');process.exit(1);}",
    "if(!token){console.error('OPENCLAW_OPENSANDBOX_ACCESS_TOKEN is required');process.exit(1);}",
    "if(!command){console.error('OPENCLAW_OPENSANDBOX_COMMAND is required');process.exit(1);}",
    "let commandEnv={};",
    "try{const parsed=JSON.parse(envJson);if(parsed&&typeof parsed==='object'&&!Array.isArray(parsed)){commandEnv=parsed;}}catch{console.error('OPENCLAW_OPENSANDBOX_ENV_JSON is invalid JSON');process.exit(1);}",
    "const headers={'Content-Type':'application/json','X-EXECD-ACCESS-TOKEN':token};",
    "const body={command,workdir,env:commandEnv,wait:true,timeout:Number.isFinite(timeout)&&timeout>0?timeout:1800};",
    "const run=async()=>{",
    "const res=await fetch(base+'/command',{method:'POST',headers,body:JSON.stringify(body)});",
    "const text=await res.text();",
    "let payload=null;",
    "try{payload=text?JSON.parse(text):null;}catch{payload={raw:text};}",
    "const root=payload&&typeof payload==='object'?payload:null;",
    "const nested=root&&root.data&&typeof root.data==='object'?root.data:root;",
    "if(!res.ok){const errRaw=nested&&'error' in nested?nested.error:(nested&&'message' in nested?nested.message:undefined);const msg=(typeof errRaw==='string'&&errRaw.trim())?errRaw.trim():(text||('OpenSandbox execd HTTP '+res.status));console.error(msg);process.exit(1);}",
    "const output=(nested&&Array.isArray(nested.output)?nested.output:[])||[];",
    "for(const item of output){",
    "const fdRaw=item&&typeof item==='object'&&'fd' in item?Number(item.fd):1;",
    "const msg=item&&typeof item==='object'&&'msg' in item?String(item.msg??''):'';",
    "if(!msg)continue;",
    "const stream=fdRaw===2?process.stderr:process.stdout;",
    "stream.write(msg);",
    "if(!msg.endsWith('\\n'))stream.write('\\n');",
    "}",
    "const exitCodeRaw=(nested&&('exit_code' in nested?nested.exit_code:('exitCode' in nested?nested.exitCode:0)))??0;",
    "const exitCode=Number(exitCodeRaw);",
    "process.exit(Number.isFinite(exitCode)?Math.max(0,Math.floor(exitCode)):0);",
    "};",
    "run().catch((err)=>{console.error(err&&err.message?err.message:String(err));process.exit(1);});",
  ].join("");

  return {
    argv: [process.execPath, "-e", script],
    env: {
      ...process.env,
      OPENCLAW_OPENSANDBOX_BASE_URL: baseUrl,
      OPENCLAW_OPENSANDBOX_ACCESS_TOKEN: accessToken,
      OPENCLAW_OPENSANDBOX_COMMAND: params.command,
      OPENCLAW_OPENSANDBOX_WORKDIR: params.workdir ?? "/workspace",
      OPENCLAW_OPENSANDBOX_ENV_JSON: envJson,
      OPENCLAW_OPENSANDBOX_TIMEOUT_SEC: String(timeoutSec),
    },
    backendId: "exec-sandbox-opensandbox",
  };
}
