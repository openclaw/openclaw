// Synthetic state only. Prepare sequentially, then serve each side of a paired browser run.
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { createServer } from "vite";
import { PROTOCOL_VERSION } from "../../packages/gateway-protocol/src/version.ts";
import { asOptionalRecord } from "../../packages/normalization-core/src/record-coerce.ts";
import { buildControlUiSessionPath } from "../../packages/session-url-contract/src/index.ts";
import { stopChild } from "../lib/gateway-bench-child.ts";
import {
  createGatewayBenchEnv,
  STALLED_CATALOG_MODEL_ID,
  STALLED_CATALOG_PROVIDER_ID,
  writePluginFixtures,
} from "../lib/gateway-bench-runtime.ts";
import { createGatewayWsClient } from "../lib/gateway-ws-client.ts";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";
import { generateTeamShapeFixture, parseTeamShapeOptions } from "./team-shape-fixture.ts";

const { values } = parseArgs({
  options: {
    "state-dir": { type: "string" },
    "ui-root": { type: "string" },
    "runtime-entry": { type: "string", default: "dist/index.js" },
    "skip-seed": { type: "boolean", default: false },
    port: { type: "string", default: "41514" },
    "proxy-port": { type: "string", default: "41516" },
    prepare: { type: "boolean", default: false },
    now: { type: "string", default: String(Date.now()) },
  },
});
if (!values["state-dir"] || !values["ui-root"]) {
  throw new Error("Expected --state-dir <synthetic-fixture> --ui-root <built-ui> [--prepare]");
}
const root = path.resolve(values["state-dir"]);
const port = parseStrictIntegerOption({
  raw: values.port,
  label: "port",
  min: 40000,
  fallback: 41514,
});
const proxyPort = parseStrictIntegerOption({
  raw: values["proxy-port"],
  label: "proxy-port",
  min: 40000,
  fallback: 41516,
});
if (port >= 65535 || proxyPort > 65535 || proxyPort === port || proxyPort === port + 1) {
  throw new Error("Reserve distinct loopback ports for Gateway, Gateway + 1 sandbox, and proxy");
}
const email = "reload-fixture@example.test";
const origin = `http://127.0.0.1:${proxyPort}`;
const configPath = path.join(root, "openclaw.json");
const selectedKey = "agent:main:team-shape-session-1";
const pinKeys = [2, 3, 4, 6, 11, 12, 13, 16].map(
  (index) => `agent:main:team-shape-session-${index}`,
);
const json = (file: string, value: unknown) =>
  writeFile(file, `${JSON.stringify(value, null, 2)}\n`);

if (values.prepare) {
  await generateTeamShapeFixture(
    parseTeamShapeOptions([
      "--state-dir",
      root,
      "--port",
      String(port),
      "--now",
      values.now,
      "--transcript-mib",
      "8",
    ]),
  );
  const { pluginsDir, pluginIds } = writePluginFixtures(root, {
    count: 7,
    providerCatalogStallMs: 0,
    providerStaticCatalogStallMs: 0,
    providerStaticCatalogModelCount: 12,
  });
  for (const [index, id] of pluginIds.entries()) {
    const directory = path.join(pluginsDir, id);
    const entry = "dist/control-ui/index.js";
    await mkdir(path.dirname(path.join(directory, entry)), { recursive: true });
    // These authored fixtures are directly runnable browser modules, with no compiler or SDK imports.
    await writeFile(
      path.join(directory, entry),
      `export default {id:${JSON.stringify(id)},activate(host){host.ui.registerPage({id:"overview",label:"Fixture plugin ${index + 1}",mount(container){container.textContent="Synthetic plugin ${index + 1}"}});host.ui.registerNavigation({id:"overview",label:"Fixture plugin ${index + 1}",page:{id:"overview"},icon:"chart"});}};\n`,
    );
    const manifestPath = path.join(directory, "openclaw.plugin.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    await json(manifestPath, {
      ...manifest,
      controlUi: { entry },
      uiCapabilities: ["page", "navigation"],
    });
  }
  const config = JSON.parse(await readFile(configPath, "utf8"));
  config.agents.defaults = {
    ...config.agents.defaults,
    model: { primary: `${STALLED_CATALOG_PROVIDER_ID}/${STALLED_CATALOG_MODEL_ID}` },
  };
  config.gateway = {
    ...config.gateway,
    trustedProxies: ["127.0.0.1", "::1"],
    auth: {
      mode: "trusted-proxy",
      identityScopes: { [email]: ["operator.admin", "operator.read", "operator.write"] },
      trustedProxy: {
        allowLoopback: true,
        allowUsers: [email],
        userHeader: "x-forwarded-user",
        requiredHeaders: ["x-forwarded-proto"],
        deviceAutoApprove: {
          enabled: true,
          scopes: ["operator.admin", "operator.read", "operator.write"],
        },
      },
    },
    controlUi: {
      enabled: true,
      root: path.resolve(values["ui-root"]),
      allowedOrigins: [origin],
      experimental: { customPlugins: true },
    },
  };
  config.plugins = {
    enabled: true,
    allow: pluginIds,
    load: { paths: [pluginsDir] },
    entries: Object.fromEntries(pluginIds.map((id) => [id, { enabled: true }])),
    slots: { memory: "none" },
  };
  await json(configPath, config);
  await json(path.join(root, "browser-storage.json"), {
    cookies: [],
    origins: [
      {
        origin,
        localStorage: [{ name: "openclaw:sidebar:sessions:collapsed-sections", value: "[]" }],
      },
    ],
  });
  console.log(JSON.stringify({ prepared: root, sessions: 5000, plugins: pluginIds.length }));
  process.exit(0);
}

const fixture = JSON.parse(await readFile(path.join(root, "team-shape-summary.json"), "utf8"));
if (fixture.format !== "openclaw-team-shape-v1") {
  throw new Error("Expected a generated team-shape fixture; never use live state");
}
await mkdir(path.join(root, "tmp"), { recursive: true });
const gateway = spawn(
  process.execPath,
  [values["runtime-entry"], "gateway", "run", "--bind", "loopback", "--port", String(port)],
  {
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: createGatewayBenchEnv(path.join(root, "home"), configPath, {
      startupTrace: false,
      caseEnv: {
        OPENCLAW_STATE_DIR: root,
        TMPDIR: path.join(root, "tmp"),
        OPENCLAW_SKIP_CHANNELS: "1",
        OPENCLAW_PROFILE: `reload-${port}`,
        OPENCLAW_SYSTEMD_UNIT: `reload-${port}`,
      },
    }),
  },
);
const log = createWriteStream(path.join(root, "browser-gateway.log"));
gateway.stdout.pipe(log);
gateway.stderr.pipe(log);
let proxy: Awaited<ReturnType<typeof createServer>> | undefined;
let client: ReturnType<typeof createGatewayWsClient> | undefined;
let cleanup: Promise<void> | undefined;
const stop = () =>
  (cleanup ??= (async () => {
    client?.close();
    await proxy?.close();
    await stopChild(gateway, { teardownGraceMs: 10_000 });
    log.end();
  })());
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => void stop().finally(() => process.exit(0)));
}
try {
  const deadline = Date.now() + 180_000;
  while (true) {
    if (gateway.exitCode !== null || gateway.signalCode !== null) {
      throw new Error("Fixture Gateway exited; inspect browser-gateway.log");
    }
    if ((await fetch(`http://127.0.0.1:${port}/readyz`).catch(() => null))?.ok) {
      break;
    }
    if (Date.now() > deadline) {
      throw new Error("Fixture Gateway readiness timed out; inspect browser-gateway.log");
    }
    await delay(500);
  }
  proxy = await createServer({
    configFile: false,
    envFile: false,
    root: path.join(root, "workspace"),
    appType: "custom",
    logLevel: "error",
    server: {
      host: "127.0.0.1",
      port: proxyPort,
      strictPort: true,
      proxy: {
        "/": {
          target: `http://127.0.0.1:${port}`,
          ws: true,
          headers: {
            "x-forwarded-for": "192.0.2.10",
            "x-forwarded-proto": "http",
            "x-forwarded-user": email,
          },
        },
      },
    },
  });
  await proxy.listen();
  if (!values["skip-seed"]) {
    client = createGatewayWsClient({ url: `ws://127.0.0.1:${proxyPort}`, origin });
    await client.waitOpen();
    const rpc = async (method: string, params: unknown) => {
      const response = await client!.request(method, params, 60_000);
      if (!response.ok) {
        throw new Error(`${method}: ${JSON.stringify(response.error)}`);
      }
      return response.payload;
    };
    await rpc("connect", {
      minProtocol: PROTOCOL_VERSION,
      maxProtocol: PROTOCOL_VERSION,
      client: { id: "openclaw-control-ui", version: "1.0.0", platform: "web", mode: "webchat" },
      role: "operator",
      scopes: ["operator.admin", "operator.read", "operator.write"],
      caps: [],
    });
    const profile = asOptionalRecord(asOptionalRecord(await rpc("users.self", {}))?.profile);
    if (typeof profile?.id !== "string") {
      throw new Error("Fixture setup requires an identified synthetic user");
    }
    for (let index = 1; index <= 120; index++) {
      await rpc("sessions.assignOwner", {
        key: `agent:main:team-shape-session-${index}`,
        owner: { type: "human", id: profile.id },
      });
    }
    const preferences = await rpc("users.prefs.set", {
      entries: { "ui.railShortcuts": pinKeys.map((key) => `session:${key}`) },
    });
    if (
      !preferences ||
      typeof preferences !== "object" ||
      !("status" in preferences) ||
      preferences.status !== "ok"
    ) {
      throw new Error("Fixture preferences require a durable synthetic profile");
    }
    for (const key of pinKeys) {
      await rpc("sessions.patch", { key, label: `Reload pin ${key.split("-").at(-1)}` });
    }
    await rpc("board.widget.put", {
      sessionKey: selectedKey,
      agentId: "main",
      name: "reload-fixture",
      title: "Reload fixture",
      content: { kind: "html", html: "<!doctype html><h1>Synthetic reload fixture</h1>" },
      placement: { tabId: "main" },
    });
    await rpc("sessions.patch", { key: selectedKey, boardFace: "dashboard" });
    client.close();
    client = undefined;
  }
  console.log(
    JSON.stringify({
      ready: true,
      origin,
      selectedKey,
      paths: ["dashboard", "chat"].map((namespace) =>
        buildControlUiSessionPath({
          namespace: namespace === "chat" ? "chat" : "dashboard",
          sessionKey: selectedKey,
          exactKey: true,
        }),
      ),
    }),
  );
  await new Promise<void>((resolve) => {
    gateway.once("close", () => resolve());
  });
} finally {
  await stop();
}
