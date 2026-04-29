const crypto = require("node:crypto");
const http = require("node:http");
const path = require("node:path");
const { createRequire } = require("node:module");

const portFile = process.argv[2];
const requireFromApp = createRequire(path.join(process.cwd(), "package.json"));
const JSZip = requireFromApp("jszip");
const packageName = "openclaw-kitchen-sink";
const pluginId = "openclaw-kitchen-sink-fixture";
const version = "0.1.3";

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
  register(api) {
    api.registerProvider({
      id: "kitchen-sink-provider",
      label: "Kitchen Sink Provider",
      docsPath: "/providers/kitchen-sink",
      auth: [],
    });
    api.registerChannel({
      plugin: {
        id: "kitchen-sink-channel",
        meta: {
          id: "kitchen-sink-channel",
          label: "Kitchen Sink Channel",
          selectionLabel: "Kitchen Sink",
          docsPath: "/channels/kitchen-sink",
          blurb: "Kitchen sink ClawHub fixture channel",
        },
        capabilities: { chatTypes: ["direct"] },
        config: {
          listAccountIds: () => ["default"],
          resolveAccount: () => ({ accountId: "default" }),
        },
        outbound: { deliveryMode: "direct" },
      },
    });
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
        name: "OpenClaw Kitchen Sink",
        channels: ["kitchen-sink-channel"],
        providers: ["kitchen-sink-provider"],
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
  const packageDetail = {
    package: {
      name: packageName,
      displayName: "OpenClaw Kitchen Sink",
      family: "code-plugin",
      runtimeId: pluginId,
      channel: "official",
      isOfficial: true,
      summary: "Kitchen sink plugin fixture for prerelease CI.",
      ownerHandle: "openclaw",
      createdAt: 0,
      updatedAt: 0,
      latestVersion: version,
      tags: { latest: version },
      capabilityTags: ["test-fixture"],
      executesCode: true,
      compatibility: {
        pluginApiRange: ">=2026.4.11",
        minGatewayVersion: "2026.4.11",
      },
      capabilities: {
        executesCode: true,
        runtimeId: pluginId,
        capabilityTags: ["test-fixture"],
        channels: ["kitchen-sink-channel"],
        providers: ["kitchen-sink-provider"],
      },
      verification: {
        tier: "source-linked",
        sourceRepo: "https://github.com/openclaw/kitchen-sink",
        hasProvenance: false,
        scanStatus: "passed",
      },
    },
  };
  const versionDetail = {
    package: {
      name: packageName,
      displayName: "OpenClaw Kitchen Sink",
      family: "code-plugin",
    },
    version: {
      version,
      createdAt: 0,
      changelog: "Fixture package for kitchen-sink plugin prerelease CI.",
      distTags: ["latest"],
      sha256hash,
      compatibility: packageDetail.package.compatibility,
      capabilities: packageDetail.package.capabilities,
      verification: packageDetail.package.verification,
    },
  };

  const json = (response, value, status = 200) => {
    response.writeHead(status, { "content-type": "application/json" });
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
      json(response, packageDetail);
      return;
    }
    if (
      url.pathname === `/api/v1/packages/${encodeURIComponent(packageName)}/versions/${version}`
    ) {
      json(response, versionDetail);
      return;
    }
    if (url.pathname === `/api/v1/packages/${encodeURIComponent(packageName)}/versions/beta`) {
      json(response, { error: "version not found" }, 404);
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
