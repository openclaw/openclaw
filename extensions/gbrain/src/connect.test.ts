import { describe, expect, it } from "vitest";
import {
  connectGbrain,
  type CommandResult,
  type ConnectDeps,
  type GbrainMcpServerEntry,
  type Health,
} from "./connect.js";

const HOME = "/home/user";
const RECEIPT = `${HOME}/.gbrain/serve/expose.json`;
const ADMIN = `${HOME}/.gbrain/serve/admin-token`;
const GBRAIN = `${HOME}/.bun/bin/gbrain`;
const BUN = `${HOME}/.bun/bin/bun`;
const MCP_URL = "http://127.0.0.1:3131/mcp";

/** A host with a fake GBrain: commands change the fake's state the way the real CLI does. */
function fakeHost(initial: {
  files?: Record<string, string>;
  executables?: string[];
  health?: Health;
  server?: GbrainMcpServerEntry;
  brain?: boolean;
  inContainer?: boolean;
  acceptedTokens?: string[];
}) {
  const files = new Map(Object.entries(initial.files ?? {}));
  const executables = new Set(initial.executables ?? []);
  let health: Health = initial.health ?? { kind: "down" };
  let brain = initial.brain ?? false;
  let server = initial.server;
  const accepted = new Set(initial.acceptedTokens ?? []);
  const commands: string[] = [];
  let minted = 0;
  const ok = (stdout = ""): CommandResult => ({ code: 0, stdout, stderr: "" });
  const deps: ConnectDeps = {
    home: HOME,
    env: {},
    inContainer: initial.inContainer ?? false,
    readFile: (file) => files.get(file),
    findExecutable: (name, candidates) =>
      [...candidates, `/usr/bin/${name}`].find((file) => executables.has(file)),
    run: async (argv) => {
      commands.push(argv.slice(1).join(" "));
      if (argv[0] === BUN) {
        executables.add(GBRAIN);
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
    health: async () => health,
    tokenAccepted: async (_url, token) => accepted.has(token),
    mintKey: async (_base, adminToken) => {
      expect(adminToken).toBe("admin-secret");
      minted += 1;
      const token = `gbrain_minted${minted}`;
      accepted.add(token);
      return token;
    },
    readServer: () => server,
    writeServer: async (entry) => {
      server = entry;
    },
    sleep: async () => {},
  };
  return {
    deps,
    commands,
    get server() {
      return server;
    },
    revoke: (token: string) => accepted.delete(token),
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
  it("sets up a fresh host through GBrain's own commands and writes one HTTP MCP entry", async () => {
    const host = fakeHost({ executables: [BUN] });
    const outcome = await connectGbrain(host.deps, { allowSetup: true });
    expect(outcome).toEqual({
      state: "connected",
      changed: true,
      version: "0.60.733.0",
      mcpUrl: MCP_URL,
    });
    expect(host.commands).toEqual([
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

  it("leaves a server entry it does not own untouched", async () => {
    const entries: GbrainMcpServerEntry[] = [
      { url: "https://brain.example.com/mcp", transport: "streamable-http" },
      { url: MCP_URL, headers: { Authorization: "Bearer ${GBRAIN_MCP_TOKEN}" } },
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
});
