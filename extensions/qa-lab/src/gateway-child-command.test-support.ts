import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export async function writePackagedGatewayFixture(root: string): Promise<string> {
  const fixturePath = path.join(root, "packaged-gateway-fixture.mjs");
  await writeFile(
    fixturePath,
    `import fs from "node:fs";
import net from "node:net";
import path from "node:path";

const args = process.argv.slice(2);
const recordPath = process.env.QA_RECORD_PATH;
const configPath = process.env.OPENCLAW_CONFIG_PATH;
const stateDir = process.env.OPENCLAW_STATE_DIR;
if (!recordPath || !configPath || !stateDir) {
  throw new Error("missing fixture environment");
}
const record = (value) => fs.appendFileSync(recordPath, JSON.stringify(value) + "\\n");
const fail = async (code, message) => {
  await new Promise((resolve) => process.stderr.write(
    message + "\\ncontext retained\\n" + "diagnostic ".repeat(400) +
    "\\nterminal failure: Authorization: Bearer fixture-tail-secret", resolve));
  process.exit(code);
};
const fixtureVersion = process.env.QA_CONFIG_RUNTIME_VERSION;
if (fixtureVersion) {
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const touchedVersion = config.meta?.lastTouchedVersion;
  if (touchedVersion && touchedVersion !== fixtureVersion) {
    throw new Error("config last written by newer runtime: " + touchedVersion);
  }
}
const authDbPath = path.join(stateDir, "agents", "qa", "agent", "openclaw-agent.sqlite");
if (args[0] === "models") {
  let stdin = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) stdin += chunk;
  const provider = args[args.indexOf("--provider") + 1];
  const configStat = fs.lstatSync(configPath);
  record({
    kind: "auth",
    args,
    stdin,
    authDbPath,
    dbExists: fs.existsSync(authDbPath),
    configPath,
    configMode: configStat.mode & 0o777,
    configRegular: configStat.isFile(),
    configSymlink: configStat.isSymbolicLink(),
    stateDir,
    env: {
      OPENCLAW_CLI: process.env.OPENCLAW_CLI,
      OPENCLAW_CONFIG_PATH: configPath,
      OPENCLAW_STATE_DIR: stateDir,
    },
  });
  fs.mkdirSync(path.dirname(authDbPath), { recursive: true });
  fs.writeFileSync(authDbPath, "fixture auth");
  if (process.env.QA_FAIL_PROVIDER === provider) {
    await fail(9, "Authorization: Bearer " + stdin.trim());
  }
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  config.fixtureProfiles = [...(config.fixtureProfiles ?? []), provider];
  if (fixtureVersion) config.meta = { lastTouchedVersion: fixtureVersion };
  fs.writeFileSync(configPath, JSON.stringify(config));
  process.exit(0);
}
if (process.env.QA_ASSERT_AUTH_HANDOFF === "1" &&
    (args[0] === "gateway" || (args[0] === "update" && !args.includes("--help")))) {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(path.join(stateDir, "state", "openclaw.sqlite"));
  try {
    const leases = db.prepare("SELECT owner_pid FROM agent_database_leases").all();
    if (leases.length) throw new Error("staged auth database still leased by parent");
    record({ kind: "auth-handoff", command: args[0], leases: leases.length });
  } finally {
    db.close();
  }
}
if (args[0] === "update") {
  const phase = args.includes("--help") ? "help" : "repair";
  if (process.env.QA_FAIL_PLUGIN_SETUP === phase) {
    record({ kind: "plugins", args, authDbPath, configPath, stateDir });
    await fail(8, "plugin fixture rejected: Authorization: Bearer " + "fixture-plugin-secret".repeat(200));
  }
  if (args.includes("--help")) {
    record({ kind: "help", args, authDbPath, configPath, stateDir });
    process.stdout.write(process.env.QA_LEGACY_PLUGIN_SETUP === "1" ? "Options: --yes" : "Options: --accept-capabilities --yes");
    process.exit(0);
  }
  if (process.env.QA_LEGACY_PLUGIN_SETUP === "1" && args.includes("--accept-capabilities")) {
    process.stderr.write("unknown option --accept-capabilities");
    process.exit(2);
  }
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const portProbe = net.createServer();
  await new Promise((resolve, reject) => {
    portProbe.once("error", reject);
    portProbe.listen(config.gateway.port, "127.0.0.1", resolve);
  });
  await new Promise((resolve, reject) => {
    portProbe.close((error) => error ? reject(error) : resolve());
  });
  record({ kind: "plugins", args, authDbPath, configPath, stateDir, configPort: config.gateway.port });
  if (fixtureVersion) config.meta = { lastTouchedVersion: fixtureVersion };
  delete config.plugins.entries["qa-lab"];
  config.plugins.allow = config.plugins.allow.filter((id) => id !== "qa-lab");
  fs.writeFileSync(configPath, JSON.stringify(config));
  process.stdout.write(JSON.stringify({ status: "ok", mode: "finalize", restart: false }));
  process.exit(0);
}
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
record({
  kind: "gateway",
  args,
  authDbPath,
  dbExists: fs.existsSync(authDbPath),
  configPath,
  authProfileIds: Object.keys(config.auth?.profiles ?? {}),
  fixtureProfiles: config.fixtureProfiles,
  configVersion: config.meta?.lastTouchedVersion,
  sourcePluginConfigured: Boolean(config.plugins?.entries?.["qa-lab"]),
  configPort: config.gateway.port,
  stateDir,
});
const gatewayAttempts = fs.readFileSync(recordPath, "utf8").trim().split("\\n")
  .map((line) => JSON.parse(line)).filter((entry) => entry.kind === "gateway").length;
if (gatewayAttempts === 1 && process.env.QA_STARTUP_RETRY) {
  process.stderr.write(process.env.QA_STARTUP_RETRY === "migration"
    ? "OpenClaw plugin migration inputs changed during startup convergence; refusing readiness."
    : "listen EADDRINUSE: address already in use");
  process.exit(18);
}
process.stderr.write("fixture gateway exit");
process.exit(17);
`,
    "utf8",
  );
  return fixturePath;
}

export async function readJsonLines(filePath: string): Promise<Array<Record<string, unknown>>> {
  const contents = await readFile(filePath, "utf8");
  return contents
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}
