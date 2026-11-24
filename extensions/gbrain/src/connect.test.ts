import { describe, expect, it } from "vitest";
import {
  authoredGbrainEntry,
  connectGbrain,
  applyGbrainConnection,
  type ConnectDeps,
  type GbrainMcpServerEntry,
  type Health,
} from "./connect.js";

const HOME = "/home/user";
const RECEIPT = `${HOME}/.gbrain/serve/expose.json`;
const ADMIN = `${HOME}/.gbrain/serve/admin-token`;
const GBRAIN = `${HOME}/.bun/bin/gbrain`;
const BUN = `${HOME}/.bun/bin/bun`;
const BUN_GLOBAL_BIN = `${HOME}/.cache/.bun/bin`;
const RELEASE_BINARY = `${HOME}/.gbrain/bin/gbrain`;
const MCP_URL = "http://127.0.0.1:3131/mcp";

/** A host with a fake GBrain: commands change the fake's state the way the real CLI does. */
function fakeHost(initial: {
  files?: Record<string, string>;
  executables?: string[];
  health?: Health;
  server?: GbrainMcpServerEntry;
  brain?: boolean;
  inContainer?: boolean;
  /** Host GBrain's server answers on; other hosts read as down. */
  serverHost?: string;
  acceptedTokens?: string[];
  /** Defaults to linux/arm64, a host GBrain publishes no release binary for. */
  platform?: string;
  arch?: string;
  /** Why the release download fails; it succeeds when unset. */
  releaseFailure?: string;
}) {
  const files = new Map(Object.entries(initial.files ?? {}));
  const setFile = (file: string, content: string) => files.set(file, content);
  const executables = new Set(initial.executables ?? []);
  let health: Health = initial.health ?? { kind: "down" };
  let brain = initial.brain ?? false;
  let server = initial.server;
  const accepted = new Set(initial.acceptedTokens ?? []);
  const commands: string[] = [];
  const releaseInstalls: string[] = [];
  let minted = 0;
  const ok = (stdout = ""): Awaited<ReturnType<ConnectDeps["run"]>> => ({
    code: 0,
    stdout,
    stderr: "",
  });
  const deps: ConnectDeps = {
    home: HOME,
    env: {},
    hosts: initial.inContainer ? ["127.0.0.1", "gbrain"] : ["127.0.0.1"],
    inContainer: initial.inContainer ?? false,
    platform: initial.platform ?? "linux",
    arch: initial.arch ?? "arm64",
    readFile: (file) => files.get(file),
    findExecutable: (name, candidates) =>
      [...candidates, `/usr/bin/${name}`].find((file) => executables.has(file)),
    run: async (argv) => {
      commands.push(argv.slice(1).join(" "));
      // Bun links global binaries where its settings say (here XDG_CACHE_HOME), not ~/.bun/bin.
      if (argv[0] === BUN && argv[1] === "pm") {
        return ok(`${BUN_GLOBAL_BIN}\n`);
      }
      if (argv[0] === BUN) {
        executables.add(`${BUN_GLOBAL_BIN}/gbrain`);
        return ok();
      }
      if (argv[1] === "init") {
        brain = true;
        return ok();
      }
      if (!brain) {
        return {
          code: 1,
          stdout: JSON.stringify({ status: "error", reason: "no_brain_config" }),
          stderr: "",
        };
      }
      files.set(RECEIPT, JSON.stringify({ port: 3131, admin_token_file: ADMIN }));
      files.set(ADMIN, "admin-secret\n");
      health = { kind: "ok", version: "0.60.733.0" };
      return ok(JSON.stringify({ status: "ok" }));
    },
    health: async (baseUrl) =>
      new URL(baseUrl).hostname === (initial.serverHost ?? "127.0.0.1") ? health : { kind: "down" },
    tokenAccepted: async (_url, token) => accepted.has(token),
    mintKey: async (_base, adminToken) => {
      expect(adminToken).toBe("admin-secret");
      minted += 1;
      const token = `gbrain_minted${minted}`;
      accepted.add(token);
      return token;
    },
    installRelease: async (asset, destination) => {
      releaseInstalls.push(`${asset} -> ${destination}`);
      if (initial.releaseFailure) {
        throw new Error(initial.releaseFailure);
      }
      executables.add(destination);
      return "0.60.734.0";
    },
    readServer: async () => server,
    writeServer: async ({ url, authorization }) => {
      server ??= {};
      applyGbrainConnection(server, url, authorization);
    },
    sleep: async () => {},
  };
  return {
    deps,
    commands,
    releaseInstalls,
    get server() {
      return server;
    },
    revoke: (token: string) => accepted.delete(token),
    setFile,
    setHealth: (next: Health) => {
      health = next;
    },
  };
}

const exposed = {
  [RECEIPT]: JSON.stringify({ port: 3131, admin_token_file: ADMIN }),
  [ADMIN]: "admin-secret",
};

describe("connectGbrain", () => {
  it("installs GBrain with Bun when Bun is present, even where a release binary exists", async () => {
    const host = fakeHost({ executables: [BUN], platform: "darwin", arch: "arm64" });
    const outcome = await connectGbrain(host.deps, { allowSetup: true });
    expect(outcome).toEqual({
      state: "connected",
      changed: true,
      version: "0.60.733.0",
      mcpUrl: MCP_URL,
    });
    expect(host.commands).toEqual([
      "pm bin -g",
      "install -g github:garrytan/gbrain#stable",
      "mcp expose --no-tailscale --yes --json",
      "init --pglite --no-embedding",
      "mcp expose --no-tailscale --yes --json",
    ]);
    expect(host.server).toEqual({
      url: MCP_URL,
      transport: "streamable-http",
      headers: { Authorization: "Bearer gbrain_minted1" },
    });
    expect(host.releaseInstalls).toEqual([]);
  });

  it("installs GBrain's release binary on Apple Silicon and x86-64 Linux without Bun", async () => {
    for (const [platform, arch, asset] of [
      ["darwin", "arm64", "gbrain-darwin-arm64"],
      ["linux", "x64", "gbrain-linux-x64"],
    ]) {
      const host = fakeHost({ platform, arch });
      expect(await connectGbrain(host.deps, { allowSetup: true })).toMatchObject({
        state: "connected",
        mcpUrl: MCP_URL,
      });
      expect(host.releaseInstalls).toEqual([`${asset} -> ${RELEASE_BINARY}`]);
      expect(host.commands).toEqual([
        "mcp expose --no-tailscale --yes --json",
        "init --pglite --no-embedding",
        "mcp expose --no-tailscale --yes --json",
      ]);
    }
  });

  it("reports a failed release download and writes nothing", async () => {
    const host = fakeHost({
      platform: "darwin",
      arch: "arm64",
      releaseFailure: "The downloaded gbrain-darwin-arm64 has no build-provenance attestation.",
    });
    expect(await connectGbrain(host.deps, { allowSetup: true })).toMatchObject({
      state: "blocked",
      reason: "gbrain-install-failed",
      message: expect.stringContaining("no build-provenance attestation"),
    });
    expect(host.server).toBeUndefined();
    expect(host.commands).toEqual([]);
  });

  it("keeps a working key and mints a new one after the old key is revoked", async () => {
    const host = fakeHost({
      executables: [GBRAIN],
      brain: true,
      files: exposed,
      health: { kind: "ok", version: "1" },
    });
    await connectGbrain(host.deps, { allowSetup: true });
    expect(await connectGbrain(host.deps, { allowSetup: true })).toMatchObject({ changed: false });
    host.revoke("gbrain_minted1");
    expect(await connectGbrain(host.deps, { allowSetup: true })).toMatchObject({ changed: true });
    expect(host.server?.headers).toEqual({ Authorization: "Bearer gbrain_minted2" });
    expect(host.commands).toEqual([]);
  });

  it("keeps the user's settings on the entry when it replaces a revoked key", async () => {
    const host = fakeHost({
      executables: [GBRAIN],
      files: exposed,
      health: { kind: "ok", version: "1" },
      server: {
        url: MCP_URL,
        transport: "streamable-http",
        enabled: false,
        toolFilter: { include: ["recall"] },
        headers: { Authorization: "Bearer gbrain_revoked", "X-Brain": "work" },
      },
    });
    expect(await connectGbrain(host.deps, { allowSetup: true })).toMatchObject({ changed: true });
    expect(host.server).toEqual({
      url: MCP_URL,
      transport: "streamable-http",
      enabled: false,
      toolFilter: { include: ["recall"] },
      headers: { Authorization: "Bearer gbrain_minted1", "X-Brain": "work" },
    });
  });

  it("follows GBrain to a new port after `gbrain mcp expose --port`", async () => {
    const host = fakeHost({
      executables: [GBRAIN],
      files: exposed,
      health: { kind: "ok", version: "1" },
    });
    await connectGbrain(host.deps, { allowSetup: true });
    host.setFile(RECEIPT, JSON.stringify({ port: 4242, admin_token_file: ADMIN }));
    expect(await connectGbrain(host.deps, { allowSetup: true })).toMatchObject({
      state: "connected",
      mcpUrl: "http://127.0.0.1:4242/mcp",
    });
    expect(host.server?.url).toBe("http://127.0.0.1:4242/mcp");
  });

  it("leaves a server entry it does not own untouched", async () => {
    const entries: GbrainMcpServerEntry[] = [
      { url: "https://brain.example.com/mcp", transport: "streamable-http" },
      { url: MCP_URL, headers: { Authorization: "Bearer ${GBRAIN_MCP_TOKEN}" } },
      { url: MCP_URL, headers: { authorization: "Bearer ${GBRAIN_MCP_TOKEN}" } },
    ];
    for (const server of entries) {
      const host = fakeHost({
        executables: [GBRAIN],
        files: exposed,
        health: { kind: "ok", version: "1" },
        server,
      });
      expect((await connectGbrain(host.deps, { allowSetup: true })).state).toBe("external");
      expect(host.server).toBe(server);
    }
  });

  it("treats only an entry written in the root config file, unchanged by includes or env, as its own", () => {
    const own = { url: MCP_URL, headers: { Authorization: "Bearer gbrain_a" } };
    const fromInclude = { url: MCP_URL, headers: { Authorization: "Bearer gbrain_b" } };
    expect(authoredGbrainEntry({ mcp: { servers: { gbrain: own } } }, own)).toEqual(own);
    expect(authoredGbrainEntry({}, undefined)).toBeUndefined();
    // Root `$include` plus a partial `mcp` in the root: the entry comes from the include.
    expect(
      authoredGbrainEntry({ $include: "brain.json5", mcp: { servers: {} } }, fromInclude),
    ).toBe("foreign");
    // Root entry that an include overrides.
    expect(
      authoredGbrainEntry(
        { $include: "brain.json5", mcp: { servers: { gbrain: own } } },
        fromInclude,
      ),
    ).toBe("foreign");
    // Root entry next to an unrelated include stays the plugin's.
    expect(
      authoredGbrainEntry({ $include: "agents.json5", mcp: { servers: { gbrain: own } } }, own),
    ).toEqual(own);
    // Headers from an include, or a bearer from an env template.
    const withHeaders = (headers: Record<string, string>) => ({
      mcp: { servers: { gbrain: { url: MCP_URL, headers } } },
    });
    expect(authoredGbrainEntry(withHeaders({ $include: "headers.json5" }), fromInclude)).toBe(
      "foreign",
    );
    expect(authoredGbrainEntry(withHeaders({ Authorization: "Bearer ${T}" }), fromInclude)).toBe(
      "foreign",
    );
  });

  it("reports what blocks the connection with the next step, and changes nothing", async () => {
    const cases: Array<[Parameters<typeof fakeHost>[0], string]> = [
      [{}, "bun-missing"],
      [{ inContainer: true }, "container-without-gbrain"],
      [
        {
          files: exposed,
          health: { kind: "status-only", message: "another serve holds the brain" },
        },
        "status-only",
      ],
      [{ files: exposed, health: { kind: "not-gbrain" } }, "port-busy"],
    ];
    for (const [initial, reason] of cases) {
      const host = fakeHost(initial);
      expect(await connectGbrain(host.deps, { allowSetup: true })).toMatchObject({
        state: "blocked",
        reason,
      });
      expect(host.server).toBeUndefined();
      expect(host.commands).toEqual([]);
    }
  });

  it("never restarts a GBrain service that is already set up, and backs off a failed bootstrap", async () => {
    const setUp = fakeHost({ executables: [GBRAIN], brain: true, files: exposed });
    expect(await connectGbrain(setUp.deps, { allowSetup: true })).toMatchObject({
      reason: "service-down",
    });
    const fresh = fakeHost({ executables: [BUN] });
    expect(await connectGbrain(fresh.deps, { allowSetup: false })).toMatchObject({
      reason: "setup-pending",
    });
    expect([...setUp.commands, ...fresh.commands]).toEqual([]);
  });

  it("connects to the gbrain Compose service from a container without running GBrain commands", async () => {
    const host = fakeHost({
      inContainer: true,
      serverHost: "gbrain",
      files: exposed,
      health: { kind: "ok", version: "1" },
    });
    expect(await connectGbrain(host.deps, { allowSetup: true })).toMatchObject({
      state: "connected",
      mcpUrl: "http://gbrain:3131/mcp",
    });
    expect(host.commands).toEqual([]);
  });
});
