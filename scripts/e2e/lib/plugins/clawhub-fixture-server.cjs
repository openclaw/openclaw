const crypto = require("node:crypto");
const http = require("node:http");
const path = require("node:path");
const { createRequire } = require("node:module");

const portFile = process.argv[2];
const requireFromApp = createRequire(path.join(process.cwd(), "package.json"));
const JSZip = requireFromApp("jszip");
const packageName = "openclaw-kitchen-sink";
const pluginId = "openclaw-kitchen-sink-fixture";
const version = "0.1.0";

async function main() {
  const zip = new JSZip();
  zip.file(
    "package/package.json",
    `${JSON.stringify(
      {
        name: packageName,
        version,
        openclaw: { extensions: ["./index.js"] },
      },
      null,
      2,
    )}\n`,
    { date: new Date(0) },
  );
  zip.file(
    "package/index.js",
    `module.exports = {
  id: "${pluginId}",
  name: "OpenClaw Kitchen Sink",
  description: "Docker E2E kitchen-sink plugin fixture",
  register(api) {
    api.on("before_agent_start", async (event, context) => ({
      kitchenSink: true,
      observedEventKeys: Object.keys(event || {}),
      observedContextKeys: Object.keys(context || {}),
    }));
    api.registerTool(() => null, { name: "kitchen_sink_tool" });
    api.registerGatewayMethod("kitchen-sink.ping", async () => ({ ok: true }));
    api.registerCli(() => {}, { commands: ["kitchen-sink"] });
    api.registerService({ id: "kitchen-sink-service", start: () => {} });
  },
};
`,
    { date: new Date(0) },
  );
  zip.file(
    "package/openclaw.plugin.json",
    `${JSON.stringify(
      {
        id: pluginId,
        configSchema: {
          type: "object",
          properties: {},
        },
      },
      null,
      2,
    )}\n`,
    { date: new Date(0) },
  );

  const archive = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  const sha256hash = crypto.createHash("sha256").update(archive).digest("hex");

  const json = (response, value) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(`${JSON.stringify(value)}\n`);
  };

  const server = http.createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    if (request.method !== "GET") {
      response.writeHead(405);
      response.end("method not allowed");
      return;
    }
    if (url.pathname === `/api/v1/packages/${encodeURIComponent(packageName)}`) {
      json(response, {
        package: {
          name: packageName,
          displayName: "OpenClaw Kitchen Sink",
          family: "code-plugin",
          channel: "official",
          isOfficial: true,
          runtimeId: pluginId,
          latestVersion: version,
          createdAt: 0,
          updatedAt: 0,
          compatibility: {
            pluginApiRange: ">=2026.4.26",
            minGatewayVersion: "2026.4.26",
          },
        },
      });
      return;
    }
    if (
      url.pathname === `/api/v1/packages/${encodeURIComponent(packageName)}/versions/${version}`
    ) {
      json(response, {
        version: {
          version,
          createdAt: 0,
          changelog: "Kitchen-sink fixture package for Docker plugin E2E.",
          sha256hash,
          compatibility: {
            pluginApiRange: ">=2026.4.26",
            minGatewayVersion: "2026.4.26",
          },
        },
      });
      return;
    }
    if (url.pathname === `/api/v1/packages/${encodeURIComponent(packageName)}/download`) {
      response.writeHead(200, {
        "content-type": "application/zip",
        "content-length": String(archive.length),
      });
      response.end(archive);
      return;
    }
    response.writeHead(404, { "content-type": "text/plain" });
    response.end(`not found: ${url.pathname}`);
  });

  server.listen(0, "127.0.0.1", () => {
    require("node:fs").writeFileSync(portFile, String(server.address().port));
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
