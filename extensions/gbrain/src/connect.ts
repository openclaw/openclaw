import path from "node:path";

/**
 * Connects OpenClaw to the brain that GBrain itself runs.
 *
 * GBrain owns the CLI install, the brain, the `gbrain serve --http` service
 * (`gbrain mcp expose`: launchd, systemd user unit, or a wrapper it prints)
 * and the bearer keys (owner API on the running server). This module only
 * runs those GBrain commands and writes one static `mcp.servers.gbrain` entry,
 * which every run (cron, heartbeat, subagents included) can reach.
 */

export const GBRAIN_SERVER_NAME = "gbrain";
export const GBRAIN_DEFAULT_PORT = 3131;
export const GBRAIN_INSTALL_SPEC = "github:garrytan/gbrain#stable";
const KEY_NAME = "openclaw";

export type GbrainMcpServerEntry = {
  url?: string;
  transport?: string;
  headers?: Record<string, unknown>;
  [key: string]: unknown;
};

export type Health =
  | { kind: "ok"; version: string }
  | { kind: "status-only"; message: string }
  | { kind: "not-gbrain" }
  | { kind: "down" };

export type CommandResult = { code: number | null; stdout: string; stderr: string };

export type ConnectDeps = {
  home: string;
  env: NodeJS.ProcessEnv;
  /** Hosts to look for GBrain's server on, in order: loopback, then the `gbrain` Compose service in a container. */
  hosts: string[];
  inContainer: boolean;
  readFile: (file: string) => string | undefined;
  findExecutable: (name: string, candidates: string[]) => string | undefined;
  run: (argv: string[], timeoutMs: number) => Promise<CommandResult>;
  health: (baseUrl: string) => Promise<Health>;
  tokenAccepted: (mcpUrl: string, token: string) => Promise<boolean>;
  mintKey: (baseUrl: string, adminToken: string, name: string) => Promise<string>;
  readServer: () => GbrainMcpServerEntry | undefined;
  writeServer: (entry: GbrainMcpServerEntry) => Promise<void>;
  sleep: (ms: number) => Promise<void>;
};

export type ConnectOutcome =
  | { state: "connected"; changed: boolean; version: string; mcpUrl: string }
  | { state: "external"; url: string }
  | { state: "blocked"; reason: string; message: string };

function gbrainDir(deps: ConnectDeps): string {
  return path.join(deps.env.GBRAIN_HOME?.trim() || deps.home, ".gbrain");
}

type Receipt = { port: number; adminTokenFile: string };

/** `gbrain mcp expose` writes `serve/expose.json`; the port and owner credential path come from it. */
function readReceipt(deps: ConnectDeps): Receipt | undefined {
  const raw = deps.readFile(path.join(gbrainDir(deps), "serve", "expose.json"));
  if (!raw) {
    return undefined;
  }
  try {
    const receipt = JSON.parse(raw) as { port?: unknown; admin_token_file?: unknown };
    if (typeof receipt.port === "number" && typeof receipt.admin_token_file === "string") {
      return { port: receipt.port, adminTokenFile: receipt.admin_token_file };
    }
  } catch {
    // A torn or foreign file reads as no receipt; expose rewrites it.
  }
  return undefined;
}

function bearer(entry: GbrainMcpServerEntry | undefined): string | undefined {
  const value = entry?.headers?.Authorization;
  return typeof value === "string" ? /^Bearer (gbrain_\S+)$/.exec(value)?.[1] : undefined;
}

/** An entry this plugin can manage: our URL, and either no credential or a literal GBrain key. */
function isManaged(entry: GbrainMcpServerEntry | undefined, mcpUrl: string): boolean {
  if (!entry) {
    return true;
  }
  if (entry.url !== mcpUrl) {
    return false;
  }
  const auth = entry.headers?.Authorization;
  return auth === undefined || bearer(entry) !== undefined;
}

function parseJson(stdout: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(stdout);
    return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function blocked(reason: string, message: string): ConnectOutcome {
  return { state: "blocked", reason, message };
}

function describeFailure(result: CommandResult): string {
  const lines = `${result.stderr}\n${result.stdout}`.trim().split("\n");
  return lines.findLast((line) => line.trim())?.trim() ?? `exit ${result.code}`;
}

/** Install the GBrain CLI with Bun, GBrain's documented installer, when it is missing. */
async function ensureCli(deps: ConnectDeps): Promise<string | ConnectOutcome> {
  const bunBin = path.join(deps.env.BUN_INSTALL?.trim() || path.join(deps.home, ".bun"), "bin");
  const candidates = [deps.env.GBRAIN_BIN?.trim(), path.join(bunBin, "gbrain")].filter(
    (value): value is string => Boolean(value),
  );
  const existing = deps.findExecutable("gbrain", candidates);
  if (existing) {
    return existing;
  }
  if (deps.inContainer) {
    return blocked(
      "container-without-gbrain",
      "GBrain is not running next to this container. Start it with the GBrain Compose overlay (docker compose -f docker-compose.yml -f deploy/gbrain/compose.yaml up -d); OpenClaw connects on its own.",
    );
  }
  const bun = deps.findExecutable("bun", [path.join(bunBin, "bun")]);
  if (!bun) {
    return blocked(
      "bun-missing",
      "GBrain needs Bun 1.4.4 or newer. Install it with: curl -fsSL https://bun.sh/install | bash (on Linux, Bun's installer also needs unzip). OpenClaw finishes the GBrain setup within a minute.",
    );
  }
  // Bun links global binaries where its own settings say (BUN_INSTALL_BIN, XDG_CACHE_HOME, ...).
  const globalBin = (await deps.run([bun, "pm", "bin", "-g"], 30_000)).stdout.trim();
  const bunCandidates = [...candidates, ...(globalBin ? [path.join(globalBin, "gbrain")] : [])];
  const linked = deps.findExecutable("gbrain", bunCandidates);
  if (linked) {
    return linked;
  }
  const install = await deps.run([bun, "install", "-g", GBRAIN_INSTALL_SPEC], 10 * 60_000);
  const installed = deps.findExecutable("gbrain", bunCandidates);
  if (install.code !== 0 || !installed) {
    return blocked(
      "gbrain-install-failed",
      `Installing GBrain failed: ${describeFailure(install)}. Run: ${bun} install -g ${GBRAIN_INSTALL_SPEC}`,
    );
  }
  return installed;
}

/** `gbrain mcp expose` installs and starts GBrain's own service; it creates the brain first when none exists. */
async function exposeService(
  deps: ConnectDeps,
  gbrain: string,
): Promise<ConnectOutcome | undefined> {
  const expose = () =>
    deps.run([gbrain, "mcp", "expose", "--no-tailscale", "--yes", "--json"], 3 * 60_000);
  let result = await expose();
  let report = parseJson(result.stdout);
  if (report?.reason === "no_brain_config") {
    const init = await deps.run([gbrain, "init", "--pglite", "--no-embedding"], 5 * 60_000);
    if (init.code !== 0) {
      return blocked(
        "gbrain-init-failed",
        `Creating the brain failed: ${describeFailure(init)}. Run: ${gbrain} init --pglite --no-embedding`,
      );
    }
    result = await expose();
    report = parseJson(result.stdout);
  }
  if (result.code !== 0 || report?.status === "error") {
    const message = typeof report?.message === "string" ? report.message : describeFailure(result);
    const next = Array.isArray(report?.next_actions) ? report.next_actions.join("; ") : "";
    return blocked(
      typeof report?.reason === "string" ? report.reason : "gbrain-expose-failed",
      `Starting GBrain's service failed: ${message}${next ? ` Next: ${next}` : ""}`,
    );
  }
  return undefined;
}

async function waitForHealth(deps: ConnectDeps, baseUrl: string): Promise<Health> {
  let health = await deps.health(baseUrl);
  for (let attempt = 0; health.kind === "down" && attempt < 30; attempt += 1) {
    await deps.sleep(1000);
    health = await deps.health(baseUrl);
  }
  return health;
}

export type ConnectOptions = {
  /** Bootstrap (install, init, `mcp expose`) is allowed on this attempt; false while backing off. */
  allowSetup: boolean;
};

export async function connectGbrain(
  deps: ConnectDeps,
  options: ConnectOptions,
): Promise<ConnectOutcome> {
  let receipt = readReceipt(deps);
  const urls = deps.hosts.map((host) => `http://${host}:${receipt?.port ?? GBRAIN_DEFAULT_PORT}`);
  const current = deps.readServer();
  if (current && !urls.some((url) => isManaged(current, `${url}/mcp`))) {
    return { state: "external", url: typeof current.url === "string" ? current.url : "" };
  }

  let baseUrl = urls[0] ?? `http://127.0.0.1:${GBRAIN_DEFAULT_PORT}`;
  let health: Health = { kind: "down" };
  for (const url of urls) {
    health = await deps.health(url);
    if (health.kind !== "down") {
      baseUrl = url;
      break;
    }
  }
  let mcpUrl = `${baseUrl}/mcp`;
  if (health.kind === "down" && receipt) {
    // GBrain's supervisor (launchd, systemd, Compose) owns restarts; OpenClaw only reports.
    return blocked(
      "service-down",
      `GBrain's service is not answering on ${baseUrl}. Check it with: gbrain mcp expose --status`,
    );
  }
  if (health.kind === "down") {
    if (!options.allowSetup) {
      return blocked(
        "setup-pending",
        `GBrain is not set up yet; OpenClaw retries the setup shortly.`,
      );
    }
    const gbrain = await ensureCli(deps);
    if (typeof gbrain !== "string") {
      return gbrain;
    }
    const failure = await exposeService(deps, gbrain);
    if (failure) {
      return failure;
    }
    receipt = readReceipt(deps);
    baseUrl = `http://127.0.0.1:${receipt?.port ?? GBRAIN_DEFAULT_PORT}`;
    mcpUrl = `${baseUrl}/mcp`;
    health = await waitForHealth(deps, baseUrl);
    if (health.kind === "down") {
      return blocked(
        "service-not-supervised",
        `GBrain's service did not start on ${baseUrl}. Check it with: ${gbrain} mcp expose --status`,
      );
    }
  }
  if (health.kind === "not-gbrain") {
    return blocked(
      "port-busy",
      `Another program answers on ${baseUrl}. Free the port, or move GBrain with: gbrain mcp expose --no-tailscale --yes --port <free port>`,
    );
  }
  if (health.kind === "status-only") {
    return blocked("status-only", health.message);
  }

  const existing = bearer(current);
  if (current?.url === mcpUrl && existing && (await deps.tokenAccepted(mcpUrl, existing))) {
    return { state: "connected", changed: false, version: health.version, mcpUrl };
  }
  const adminToken = receipt ? deps.readFile(receipt.adminTokenFile)?.trim() : undefined;
  if (!adminToken) {
    return blocked(
      "admin-token-missing",
      `GBrain's owner credential is missing (${path.join(gbrainDir(deps), "serve", "admin-token")}). Run: gbrain mcp expose --no-tailscale --yes`,
    );
  }
  const token = await deps.mintKey(baseUrl, adminToken, KEY_NAME);
  await deps.writeServer({
    url: mcpUrl,
    transport: "streamable-http",
    headers: { Authorization: `Bearer ${token}` },
  });
  return { state: "connected", changed: true, version: health.version, mcpUrl };
}
