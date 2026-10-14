// Runs inside the immutable release image with only synthetic, tmpfs-backed state.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { get } from "node:http";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const root = "/app";
const home = "/permission-state/home";
const port = 18789;
const token = randomBytes(32).toString("hex");
const sha256 = (body) => createHash("sha256").update(body).digest("hex");
const json = (file) => JSON.parse(readFileSync(file, "utf8"));

function http(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const request = get(`http://127.0.0.1:${port}${url}`, { headers }, (response) => {
      const chunks = [];
      let bytes = 0;
      response.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes > 16 * 1024 * 1024) {
          response.destroy(new Error(`Oversized proof response: ${url}`));
        } else {
          chunks.push(chunk);
        }
      });
      response.on("error", reject);
      response.on("end", () =>
        resolve({
          status: response.statusCode,
          headers: response.headers,
          body: Buffer.concat(chunks),
        }),
      );
    });
    request.setTimeout(10_000, () => request.destroy(new Error(`HTTP timeout: ${url}`)));
    request.on("error", reject);
  });
}

async function assertAsset(url, file, type, headers, encoding) {
  const response = await http(url, { "Accept-Encoding": "identity", ...headers });
  assert.equal(response.status, 200, `Asset HTTP status: ${url}`);
  assert.match(String(response.headers["content-type"]), type, `Asset MIME: ${url}`);
  assert.equal(response.headers["content-encoding"], encoding, `Asset encoding: ${url}`);
  assert.equal(sha256(response.body), sha256(readFileSync(file)), `Asset bytes: ${url}`);
}

async function assertAnonymousCatalogDenied() {
  const socket = new WebSocket(`ws://127.0.0.1:${port}`);
  try {
    const response = await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Anonymous catalog authentication timeout")),
        10_000,
      );
      socket.addEventListener(
        "error",
        () => {
          clearTimeout(timer);
          reject(new Error("Anonymous catalog socket error"));
        },
        { once: true },
      );
      socket.addEventListener(
        "open",
        () =>
          socket.send(
            JSON.stringify({
              type: "req",
              id: "anonymous-catalog-connect",
              method: "connect",
              params: {
                minProtocol: 1,
                maxProtocol: 999,
                client: { id: "cli", version: "permission-proof", platform: "linux", mode: "cli" },
                role: "operator",
                scopes: ["operator.read"],
                caps: [],
              },
            }),
          ),
        { once: true },
      );
      socket.addEventListener("message", ({ data }) => {
        const frame = JSON.parse(String(data));
        if (frame.type === "res" && frame.id === "anonymous-catalog-connect") {
          clearTimeout(timer);
          resolve(frame);
        }
      });
    });
    assert.equal(response.ok, false, "Anonymous catalog connection unexpectedly authenticated");
    assert(
      ["AUTH_TOKEN_MISSING", "DEVICE_IDENTITY_REQUIRED"].includes(response.error?.details?.code),
      "Anonymous catalog denial must be authentication/identity, not a protocol/fixture failure",
    );
  } finally {
    socket.close();
  }
}

function browserAssets(directory, prefix = "") {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const name = `${prefix}${entry.name}`;
    if (entry.isDirectory()) {
      return browserAssets(path.join(directory, entry.name), `${name}/`);
    }
    return entry.isFile() && /\.(?:m?js|css)$/u.test(name) ? [name] : [];
  });
}

mkdirSync(home, { recursive: true, mode: 0o700 });
const env = {
  ...process.env,
  HOME: home,
  USERPROFILE: home,
  OPENCLAW_HOME: home,
  OPENCLAW_STATE_DIR: `${home}/.openclaw`,
  OPENCLAW_CONFIG_PATH: `${home}/.openclaw/openclaw.json`,
  OPENCLAW_NO_ONBOARD: "1",
  OPENCLAW_SUPPRESS_NOTES: "1",
  OPENCLAW_SKIP_CHANNELS: "1",
  OPENCLAW_SKIP_CRON: "1",
  OPENCLAW_SKIP_GMAIL_WATCHER: "1",
  OPENCLAW_DISABLE_BUNDLED_ENTRY_SOURCE_FALLBACK: "1",
  COREPACK_ENABLE_NETWORK: "0",
  PNPM_CONFIG_OFFLINE: "true",
  AWS_EC2_METADATA_DISABLED: "true",
  AWS_CONFIG_FILE: `${home}/aws-config`,
  AWS_SHARED_CREDENTIALS_FILE: `${home}/aws-credentials`,
};
mkdirSync(env.OPENCLAW_STATE_DIR, { mode: 0o700 });
assert.match(
  execFileSync("pnpm", ["--version"], { env, cwd: root, encoding: "utf8", timeout: 30_000 }),
  /^\d+\.\d+\.\d+/u,
);
let browser = false;
if (process.env.OPENCLAW_PERMISSION_PROOF_BROWSER === "1") {
  const findBrowser = (directory, depth = 0) => {
    if (depth > 5) {
      return undefined;
    }
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isFile() && ["chrome", "chromium", "chrome-headless-shell"].includes(entry.name)) {
        return file;
      }
      if (entry.isDirectory()) {
        const found = findBrowser(file, depth + 1);
        if (found) {
          return found;
        }
      }
    }
    return undefined;
  };
  const executable = findBrowser("/home/node/.cache/ms-playwright");
  assert(executable, "Browser variant omitted its executable");
  assert.match(
    execFileSync(executable, ["--version"], { env, cwd: home, encoding: "utf8", timeout: 30_000 }),
    /(?:Chrome|Chromium)/u,
  );
  browser = true;
}
const installed = readdirSync(`${root}/dist/extensions`, { withFileTypes: true }).flatMap(
  (entry) => {
    const pluginRoot = `${root}/dist/extensions/${entry.name}`;
    const manifest = `${pluginRoot}/openclaw.plugin.json`;
    if (!entry.isDirectory() || !existsSync(manifest)) {
      return [];
    }
    const metadata = json(manifest);
    return metadata.controlUi ? [{ root: pluginRoot, metadata }] : [];
  },
);
if (process.env.OPENCLAW_PERMISSION_PROOF_LEGACY !== "1") {
  const plan = json(`${root}/dist/runtime-artifact-plan.json`);
  assert.equal(plan.schemaVersion, 1);
  assert.deepEqual(
    installed
      .map(({ metadata }) => metadata.id)
      .toSorted((left, right) => (left < right ? -1 : left > right ? 1 : 0)),
    plan.plugins
      .filter((plugin) => plugin.controlUi)
      .map((plugin) => plugin.id)
      .toSorted((left, right) => (left < right ? -1 : left > right ? 1 : 0)),
    "Final image UI membership differs from the source-derived artifact plan",
  );
}
writeFileSync(
  env.OPENCLAW_CONFIG_PATH,
  JSON.stringify({
    gateway: {
      mode: "local",
      port,
      bind: "loopback",
      auth: { mode: "token", token },
      controlUi: { enabled: true },
    },
    // Bundled channel plugins stay startup-lazy until channel intent is configured.
    // Transport startup remains disabled by OPENCLAW_SKIP_CHANNELS in this proof.
    channels: Object.fromEntries(
      installed.flatMap(({ metadata }) =>
        (metadata.channels ?? []).map((channelId) => [channelId, { enabled: true }]),
      ),
    ),
    plugins: {
      enabled: true,
      entries: Object.fromEntries(
        installed.map(({ metadata }) => [metadata.id, { enabled: true }]),
      ),
    },
  }),
  { mode: 0o600 },
);
const gateway = spawn(process.execPath, ["/app/openclaw.mjs", "gateway", "run"], {
  env,
  cwd: home,
  stdio: ["ignore", "pipe", "pipe"],
});
let log = "";
for (const stream of [gateway.stdout, gateway.stderr]) {
  stream.on("data", (chunk) => {
    log = (log + chunk).slice(-64 * 1024);
  });
}
let signalTimer;
try {
  const deadline = Date.now() + 180_000;
  let ready = false;
  while (Date.now() < deadline) {
    assert.equal(gateway.exitCode, null, `Gateway exited before startup: ${log}`);
    try {
      ready = (await http("/startupz")).status === 200;
    } catch {
      /* Startup admission owns readiness. */
    }
    if (ready) {
      break;
    }
    await delay(100);
  }
  assert(ready, `Gateway startup timed out: ${log}`);
  const document = await http("/", { Accept: "text/html", "Accept-Encoding": "identity" });
  assert.equal(document.status, 200, "Core Control UI document status");
  assert.match(String(document.headers["content-type"]), /^text\/html/u);
  assert.match(document.body.toString(), /<\/html>/iu);
  const original = readFileSync(`${root}/dist/control-ui/index.html`, "utf8");
  const assetReferences = (html) =>
    [...html.matchAll(/(?:src|href)=["']([^"']+)["']/giu)]
      .map((match) => match[1])
      .filter((reference) => /\.(?:js|css)(?:\?[^"']*)?$/u.test(reference));
  const references = assetReferences(document.body.toString());
  const normalizeAsset = (reference) => new URL(reference, "http://proof/").pathname;
  const servedPaths = new Set(references.map(normalizeAsset));
  for (const tag of original.match(/<(?:script|link)\b[^>]*>/giu) ?? []) {
    if (!/^<script\b/iu.test(tag) && !/rel=["']stylesheet["']/iu.test(tag)) {
      continue;
    }
    for (const reference of assetReferences(tag)) {
      assert(
        servedPaths.has(normalizeAsset(reference)),
        `Served document omitted required asset ${reference}`,
      );
    }
  }
  assert(
    references.some((name) => /\.js(?:\?|$)/u.test(name)),
    "Core document omitted JS",
  );
  assert(
    references.some((name) => /\.css(?:\?|$)/u.test(name)),
    "Core document omitted CSS",
  );
  let compressedAssets = 0;
  for (const reference of new Set(references)) {
    const assetPath = normalizeAsset(reference);
    const file = path.join(root, "dist/control-ui", assetPath);
    const type = assetPath.endsWith(".css") ? /^text\/css/u : /^(?:text|application)\/javascript/u;
    await assertAsset(assetPath, file, type);
    for (const [suffix, encoding] of [
      [".br", "br"],
      [".gz", "gzip"],
    ]) {
      if (existsSync(`${file}${suffix}`)) {
        await assertAsset(
          assetPath,
          `${file}${suffix}`,
          type,
          { "Accept-Encoding": encoding },
          encoding,
        );
        compressedAssets++;
      }
    }
  }
  if (process.env.OPENCLAW_PERMISSION_PROOF_LEGACY !== "1") {
    assert(compressedAssets > 0, "Core build omitted precompressed serving proof");
  }
  await assertAnonymousCatalogDenied();
  const catalogText = execFileSync(
    process.execPath,
    [
      "/app/openclaw.mjs",
      "gateway",
      "call",
      "plugins.controlUi.list",
      "--url",
      `ws://127.0.0.1:${port}`,
      "--token",
      token,
      "--json",
      "--timeout",
      "60000",
    ],
    { env, cwd: home, encoding: "utf8", timeout: 90_000, maxBuffer: 1024 * 1024 },
  );
  const catalog = JSON.parse(catalogText);
  assert(Array.isArray(catalog.plugins), "Authenticated catalog omitted plugins");
  assert.equal(
    catalog.diagnostics.length,
    0,
    `Plugin UI diagnostics: ${JSON.stringify(catalog.diagnostics)}`,
  );
  let pluginAssets = 0;
  for (const { root: pluginRoot, metadata } of installed) {
    const plugin = catalog.plugins.find((item) => item.pluginId === metadata.id);
    assert(plugin, `Authenticated catalog omitted declared UI plugin ${metadata.id}`);
    const declaration = metadata.controlUi;
    const directory = path.dirname(path.join(pluginRoot, declaration.entry));
    const entryName = path.basename(declaration.entry);
    const prefix = `/__openclaw__/plugins/control-ui/${encodeURIComponent(metadata.id)}/${plugin.revision}/`;
    assert.equal(plugin.entryUrl, prefix + entryName);
    assert.deepEqual(
      plugin.styles,
      (declaration.styles ?? []).map(
        (style) =>
          prefix + path.relative(directory, path.join(pluginRoot, style)).split(path.sep).join("/"),
      ),
    );
    for (const name of browserAssets(directory)) {
      const url = prefix + name.split("/").map(encodeURIComponent).join("/");
      const anonymous = await http(url, { "Accept-Encoding": "identity" });
      assert(
        [401, 403].includes(anonymous.status),
        `Anonymous plugin asset must be denied: ${url} returned ${anonymous.status}`,
      );
      await assertAsset(
        url,
        path.join(directory, name),
        name.endsWith(".css") ? /^text\/css/u : /^text\/javascript/u,
        { Authorization: `Bearer ${token}` },
      );
      pluginAssets++;
    }
  }
  console.log(
    JSON.stringify({
      schemaVersion: 1,
      uid: process.getuid(),
      gid: process.getgid(),
      groups: process.getgroups(),
      offlineToolchain: true,
      browser,
      anonymousCatalogDenied: true,
      coreAssets: new Set(references).size,
      compressedAssets,
      pluginUiCount: installed.length,
      pluginAssets,
    }),
  );
} catch (error) {
  console.error(log);
  throw error;
} finally {
  if (gateway.exitCode === null && gateway.signalCode === null) {
    const closed = new Promise((resolve) => {
      gateway.once("close", resolve);
    });
    gateway.kill("SIGTERM");
    signalTimer = setTimeout(() => gateway.kill("SIGKILL"), 10_000);
    await closed;
    clearTimeout(signalTimer);
  }
}
