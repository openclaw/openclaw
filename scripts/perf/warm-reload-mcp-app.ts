import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { buildSync } from "esbuild";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";

const require = createRequire(new URL("../../ui/package.json", import.meta.url));

/** Real stdio MCP server + official App SDK, inside the existing warm reload fixture. */
export function seedWarmReloadMcpApp(stateDir: string): OpenClawConfig["mcp"] {
  const app = buildSync({
    stdin: {
      contents: `import { App } from ${JSON.stringify(require.resolve("@modelcontextprotocol/ext-apps/app-with-deps"))};
    const report = phase => window.top.postMessage({type:'warm-reload-proof:mcp-app',phase}, '*');
    const app = new App({name:'Synthetic reload dashboard',version:'1.0.0'});
    app.ontoolinput = () => report('tool-input');
    app.ontoolresult = result => {
      report('tool-result');
      const data = result.structuredContent;
      document.getElementById('dashboard').innerHTML = '<h1>Synthetic reload dashboard</h1><div class="tiles">' +
        data.metrics.map(item => '<article><strong>' + item.value + '</strong>' + item.label + '</article>').join('') + '</div>' +
        data.charts.map(points => '<h2>Verification throughput</h2><svg viewBox="0 0 1000 300"><polyline fill="none" stroke="#70dfbd" stroke-width="5" points="' + points + '"/></svg>').join('');
      document.fonts.ready.then(() => requestAnimationFrame(() => requestAnimationFrame(() => {
        report('paint');
        window.top.postMessage({type:'warm-reload-proof:dashboard-content-ready'}, '*');
      })));
    };
    await app.connect(); report('initialized');`,
      resolveDir: process.cwd(),
    },
    bundle: true,
    format: "esm",
    minify: true,
    write: false,
  }).outputFiles[0]!.text;
  const html = `<!doctype html><html><head><style>
    *{box-sizing:border-box}body{margin:0;padding:32px;background:#10262c;color:#edf8f6;font:18px system-ui;min-height:1400px}
    .tiles{display:flex;gap:20px}article{background:#1d4248;border-radius:12px;padding:28px;flex:1}strong{font-size:44px;display:block}
    svg{width:100%;height:360px;background:#16373d;border-radius:12px;margin-top:24px}
    </style></head><body><main id="dashboard"></main><script type="module">
    ${app.replaceAll("</script", "<\\/script")}
    </script></body></html>`;
  const serverPath = path.join(stateDir, "warm-reload-mcp-server.mjs");
  writeFileSync(
    serverPath,
    `
    import { McpServer } from ${JSON.stringify(require.resolve("@modelcontextprotocol/server"))};
    import { StdioServerTransport } from ${JSON.stringify(require.resolve("@modelcontextprotocol/server/stdio"))};
    const server = new McpServer({name:'warm-reload',version:'1.0.0'});
    const uri = 'ui://warm-reload/dashboard';
    const tool = server.registerTool('dashboard', {description:'Synthetic KPI dashboard'}, async () => ({
      content:[{type:'text',text:'Synthetic dashboard result'}],
      structuredContent:{metrics:[{value:3000,label:'sessions'},{value:9,label:'rows'},{value:11,label:'reloads'}],
        charts:['0,250 150,220 300,230 450,160 600,180 750,100 1000,40','0,240 150,190 300,210 450,130 600,150 750,70 1000,30']}
    }));
    tool.update({_meta:{ui:{resourceUri:uri,entrypoints:[{type:'thread'}]}}});
    server.registerResource('dashboard',uri,{mimeType:'text/html;profile=mcp-app'},async () => ({contents:[{
      uri,mimeType:'text/html;profile=mcp-app',text:${JSON.stringify(html)}
    }]}));
    await server.connect(new StdioServerTransport());
  `,
  );
  return {
    apps: { enabled: true },
    servers: {
      "warm-reload": {
        command: process.execPath,
        args: [serverPath],
        cwd: stateDir,
        codex: { defaultToolsApprovalMode: "approve" },
      },
    },
  };
}
