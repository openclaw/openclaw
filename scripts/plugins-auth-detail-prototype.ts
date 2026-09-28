import { execFile } from "node:child_process";
// Throwaway detail-page prototype on main 018639af3b54.
// Run: node --import ./scripts/tsx.mjs scripts/plugins-auth-detail-prototype.ts
// The inventory is a fixture; auth observations come from real Notion servers.
import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import {
  auth,
  extractWWWAuthenticateParams,
  type OAuthClientProvider,
} from "@modelcontextprotocol/sdk/client/auth.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createServer, type Plugin } from "vite";
import type {
  PluginCatalogEntry,
  PluginsInspectResult,
} from "../packages/gateway-protocol/src/schema/plugins.ts";
import {
  createControlUiMockBootstrapConfig,
  createControlUiMockGatewayInitScript,
} from "../ui/src/test-helpers/control-ui-e2e.ts";
import { buildPluginCatalogMock, buildPluginInspectMock } from "./control-ui-mock-plugins.ts";

const root = process.cwd();
const port = 5201;
const artifacts = path.join(root, ".artifacts/mcp-auth-detail");
try {
  await access(path.join(artifacts, "vendor/package/bin/cli.mjs"));
} catch {
  await mkdir(path.join(artifacts, "vendor"), { recursive: true });
  const response = await fetch(
    "https://registry.npmjs.org/@notionhq/notion-mcp-server/-/notion-mcp-server-2.5.2.tgz",
  );
  if (!response.ok) {
    throw new Error("Could not download pinned Notion server");
  }
  const archive = Buffer.from(await response.arrayBuffer());
  const digest = createHash("sha512").update(archive).digest("base64");
  if (
    digest !==
    "5nPSwHMnugSGAhSJS5vVIlMao+iTJO9HoWGpCnT8lJNrPy3rZMqs1V/CPiN4MuxF+5EBgRE/f/Tirl6Wfi75Mg=="
  ) {
    throw new Error("Notion package integrity mismatch");
  }
  const file = path.join(artifacts, "vendor/notion-2.5.2.tgz");
  await writeFile(file, archive);
  await promisify(execFile)("tar", ["-xzf", file, "-C", path.join(artifacts, "vendor")]);
}
const revision = "9847f2aa1a15f25df35ed1fb7b4557dbb60cd651";
const upstreamSource = `https://raw.githubusercontent.com/makenotion/claude-code-notion-plugin/${revision}`;
const manifest = await fetch(`${upstreamSource}/.claude-plugin/plugin.json`).then((r) => r.json());
const mcp = await fetch(`${upstreamSource}/.mcp.json`).then((r) => r.json());
const endpoint = mcp.mcpServers.notion.url as string;
await mkdir(artifacts, { recursive: true });
await writeFile(
  path.join(artifacts, "upstream-manifests.json"),
  JSON.stringify({ revision, manifest, mcp }, null, 2),
);
const catalog = buildPluginCatalogMock();
const inspections: {
  cases: Array<{ match: { pluginId: string }; response: PluginsInspectResult }>;
} = buildPluginInspectMock();
const base = inspections.cases[0]!.response;
const examples = [
  {
    id: "notion",
    name: manifest.name,
    version: manifest.version,
    description: "Search your workspace, read pages, and keep knowledge up to date.",
    repository: manifest.repository,
    server: "notion",
    readme:
      "## Connect your workspace\nThis is Notion’s official plugin, with its hosted MCP server at `https://mcp.notion.com/mcp`.\n\nSign in to choose the workspace your agent can access.",
  },
  {
    id: "notion-local",
    name: "Notion (local)",
    version: "2.5.2",
    description: "Use Notion from a local MCP server with an integration token.",
    repository: "https://github.com/makenotion/notion-mcp-server",
    server: "notionApi",
    readme:
      "## Local server\nRuns the official `@notionhq/notion-mcp-server@2.5.2` package over stdio. This example wraps it in a local bundle for the prototype.\n\nThe local server is no longer actively maintained by Notion; their hosted server is recommended for new connections.\n\nThe connection check calls only `API-get-self`, a read-only account endpoint.",
  },
];
for (const example of examples.toReversed()) {
  const plugin = {
    id: example.id,
    name: example.name,
    version: example.version,
    description: example.description,
    category: "tool",
    origin: "global",
    installed: true,
    enabled: true,
    state: "enabled",
    removable: true,
  } satisfies PluginCatalogEntry;
  catalog.plugins.unshift(plugin);
  inspections.cases.push({
    match: { pluginId: example.id },
    response: {
      ...base,
      plugin,
      source: { kind: "path" },
      declared: { ...base.declared, channels: [], cliCommands: [], mcpServers: [example.server] },
      components: { ...base.components, mcpServers: [example.server] },
      overview: {
        publisherName: "Notion Labs",
        repositoryUrl: example.repository,
        readme: example.readme,
      },
    },
  });
}
const scenario = {
  serverVersion: "2026.9.6",
  serverBuildId: "auth-detail-018639af",
  methodResponses: { "plugins.list": catalog, "plugins.inspect": inspections },
};

// This disposable local browser session holds OAuth data in memory only.
let clientInfo: Awaited<ReturnType<OAuthClientProvider["clientInformation"]>>;
let tokens: Awaited<ReturnType<OAuthClientProvider["tokens"]>>;
let verifier = "";
let oauthState = "";
let authorizationUrl = "";
const provider: OAuthClientProvider = {
  redirectUrl: `http://localhost:${port}/__auth-detail/callback`,
  clientMetadata: {
    client_name: "OpenClaw plugin auth prototype",
    redirect_uris: [`http://localhost:${port}/__auth-detail/callback`],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  },
  state: () => oauthState,
  clientInformation: () => clientInfo,
  saveClientInformation: (value) => {
    clientInfo = value;
  },
  tokens: () => tokens,
  saveTokens: (value) => {
    tokens = value;
  },
  saveCodeVerifier: (value) => {
    verifier = value;
  },
  codeVerifier: () => verifier,
  redirectToAuthorization: (url) => {
    authorizationUrl = url.href;
  },
};
async function probeHttp() {
  const response = await fetch(endpoint, {
    method: "POST",
    signal: AbortSignal.timeout(12_000),
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(tokens ? { Authorization: `Bearer ${tokens.access_token}` } : {}),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "openclaw-auth-prototype", version: "1.0.0" },
      },
    }),
  });
  const challenge = extractWWWAuthenticateParams(response);
  const metadataUrl = challenge.resourceMetadataUrl?.href;
  const state =
    response.status === 401
      ? "needs-auth"
      : response.status === 403 && challenge.error === "insufficient_scope"
        ? "needs-permission"
        : response.ok
          ? "connected"
          : "unavailable";
  // The endpoint is pinned to Notion; discovery must stay with this known provider.
  const metadata =
    metadataUrl && new URL(metadataUrl).origin === "https://mcp.notion.com"
      ? await fetch(metadataUrl, { signal: AbortSignal.timeout(12_000) })
          .then((r) => {
            if (!r.ok) {
              throw new Error("Discovery unavailable");
            }
            return r.json();
          })
          .catch(() => ({
            error:
              "OAuth metadata could not be loaded; the authentication challenge is still valid.",
          }))
      : undefined;
  await response.body?.cancel();
  return {
    state,
    detector: "MCP HTTP authorization challenge",
    transport: "Streamable HTTP",
    endpoint,
    httpStatus: response.status,
    challenge: response.headers.get("www-authenticate"),
    metadata,
    checkedAt: new Date().toISOString(),
  };
}
async function probeStdio() {
  const client = new Client({ name: "openclaw-auth-prototype", version: "1.0.0" });
  // Do not inherit operator credentials: this example intentionally has no token.
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(artifacts, "vendor/package/bin/cli.mjs"), "--transport", "stdio"],
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
    stderr: "pipe",
  });
  transport.stderr?.on("data", () => {});
  try {
    await client.connect(transport, { timeout: 12_000 });
    const { tools } = await client.listTools();
    const result = await client.callTool({ name: "API-get-self", arguments: {} }, undefined, {
      timeout: 12_000,
    });
    const content = result.content as Array<{ type: string; text?: string }>;
    const account = JSON.parse(content.find((item) => item.type === "text")?.text ?? "{}");
    // Vendor contract: the proxy returns Notion's structured API error in text content.
    // A live MCP process and a successful tools/list do not establish Notion access.
    const state =
      account.object === "error" && account.status === 401 && account.code === "unauthorized"
        ? "needs-auth"
        : account.object === "user"
          ? "connected"
          : "unavailable";
    return {
      state,
      detector: "Notion account check",
      transport: "Local stdio",
      package: "@notionhq/notion-mcp-server@2.5.2",
      initialized: true,
      toolCount: tools.length,
      tool: "API-get-self",
      credential: "NOTION_TOKEN is absent in this isolated process",
      result: account,
      checkedAt: new Date().toISOString(),
    };
  } finally {
    await client.close();
  }
}
const prototype: Plugin = {
  name: "plugin-auth-detail-prototype",
  enforce: "pre",
  transform(source, id) {
    if (id.endsWith("/pages/plugins/settings-view.ts")) {
      return source.replace(
        'id: "plugin-installed-detail",',
        'id: "plugin-installed-detail", prototypePluginId: plugin.id,',
      );
    }
    if (!id.endsWith("/pages/plugins/detail-shell.ts")) {
      return undefined;
    }
    const detailSource = source.replace(
      "  id: string;",
      "  id: string; prototypePluginId?: string;",
    );
    return (
      'import "./auth-detail-prototype.ts";\n' +
      detailSource.replace(
        '<div class="plugin-catalog-detail__content">',
        '<openclaw-auth-detail-prototype .pluginId=${props.prototypePluginId ?? ""}></openclaw-auth-detail-prototype>\n<div class="plugin-catalog-detail__content">',
      )
    );
  },
  transformIndexHtml(html) {
    return html.replace(
      "</head>",
      `<script>localStorage.setItem("openclaw.i18n.locale", "en");\n${createControlUiMockGatewayInitScript(scenario)}</script></head>`,
    );
  },
  configureServer(server) {
    server.middlewares.use((req, res, next) => {
      void (async () => {
        const url = new URL(req.url ?? "/", `http://localhost:${port}`);
        const send = (data: unknown, status = 200) => {
          res.statusCode = status;
          res.setHeader("Content-Type", "application/json");
          res.setHeader("Cache-Control", "no-store");
          res.end(JSON.stringify(data));
        };
        if (url.pathname.endsWith("control-ui-config.json")) {
          return send(createControlUiMockBootstrapConfig(scenario));
        }
        if (!url.pathname.startsWith("/__auth-detail/")) {
          return next();
        }
        if (url.pathname.endsWith("/callback")) {
          if (!oauthState || url.searchParams.get("state") !== oauthState) {
            return send({ error: "This sign-in session has expired." }, 400);
          }
          oauthState = "";
          if (!url.searchParams.get("code")) {
            return send(
              { error: "Sign-in was canceled. Return to the plugin and try again." },
              400,
            );
          }
          await auth(provider, {
            serverUrl: endpoint,
            authorizationCode: url.searchParams.get("code")!,
          });
          res.writeHead(302, { Location: "/settings/plugins/notion" });
          res.end();
          return;
        }
        if (req.method !== "POST" || req.headers.origin !== `http://localhost:${port}`) {
          return send({ error: "Use the local prototype page." }, 403);
        }
        if (url.pathname.endsWith("/start")) {
          oauthState = randomUUID();
          await auth(provider, { serverUrl: endpoint });
          return send({ url: authorizationUrl });
        }
        if (url.pathname.endsWith("/probe")) {
          const id = url.searchParams.get("plugin");
          if (id !== "notion" && id !== "notion-local") {
            return send({ state: "unsupported" });
          }
          const result = await (id === "notion" ? probeHttp() : probeStdio());
          await writeFile(
            path.join(artifacts, `${id}-observation.json`),
            JSON.stringify(result, null, 2),
          );
          return send(result);
        }
        send({ error: "Unknown endpoint" }, 404);
      })().catch(() => {
        res.statusCode = 502;
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({ state: "unavailable", error: "Connection check failed. Try again." }),
        );
      });
    });
  },
};
const server = await createServer({
  configFile: path.join(root, "ui/vite.config.ts"),
  root: path.join(root, "ui"),
  cacheDir: path.join(artifacts, "vite"),
  plugins: [prototype],
  define: {
    "globalThis.OPENCLAW_CONTROL_UI_BUILD_INFO": JSON.stringify({
      version: "2026.9.6",
      buildId: scenario.serverBuildId,
      commit: "018639af3b54",
      commitAt: null,
      builtAt: null,
      branch: "codex/plugin-auth-detail",
      dirty: true,
      release: false,
    }),
  },
  server: { host: "127.0.0.1", port, strictPort: true, watch: null },
});
await server.listen();
console.log(`Plugin auth detail prototype: http://localhost:${port}/settings/plugins/notion`);
await new Promise<void>((resolve) => {
  process.once("SIGINT", resolve);
  process.once("SIGTERM", resolve);
});
await server.close();
