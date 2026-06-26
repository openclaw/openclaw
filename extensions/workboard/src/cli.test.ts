// Workboard tests cover cli plugin behavior.
import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerWorkboardCli } from "./cli.js";
import { WorkboardStore, type PersistedWorkboardCard, type WorkboardKeyedStore } from "./store.js";

const gatewayRuntime = vi.hoisted(() => ({
  callGatewayFromCli: vi.fn(),
  getRuntimeConfig: vi.fn(() => ({})),
}));

vi.mock("openclaw/plugin-sdk/gateway-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/gateway-runtime")>(
    "openclaw/plugin-sdk/gateway-runtime",
  );
  return {
    ...actual,
    callGatewayFromCli: gatewayRuntime.callGatewayFromCli,
  };
});

vi.mock("openclaw/plugin-sdk/runtime-config-snapshot", () => ({
  getRuntimeConfig: gatewayRuntime.getRuntimeConfig,
}));

function createMemoryStore<T = PersistedWorkboardCard>(): WorkboardKeyedStore<T> {
  const entries = new Map<string, T>();
  return {
    async register(key, value) {
      entries.set(key, value);
    },
    async lookup(key) {
      return entries.get(key);
    },
    async delete(key) {
      return entries.delete(key);
    },
    async entries() {
      return [...entries].flatMap(([key, value]) => (value ? [{ key, value }] : []));
    },
  };
}

function createProgram(store: WorkboardStore): Command {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({
    writeErr: () => {},
    writeOut: () => {},
  });
  registerWorkboardCli({ program, store });
  return program;
}

async function createAmbiguousPrefix(store: WorkboardStore): Promise<string> {
  const seen = new Map<string, string>();
  for (let index = 0; index < 40; index += 1) {
    const card = await store.create({ title: `Card ${index}` });
    const prefix = card.id.slice(0, 1);
    if (seen.has(prefix)) {
      return prefix;
    }
    seen.set(prefix, card.id);
  }
  throw new Error("could not create cards with a shared prefix");
}

async function captureStdout(run: () => Promise<void>): Promise<string> {
  const chunks: string[] = [];
  const write = vi.spyOn(process.stdout, "write").mockImplementation((chunk): boolean => {
    chunks.push(String(chunk));
    return true;
  });
  try {
    await run();
    return chunks.join("");
  } finally {
    write.mockRestore();
  }
}

describe("registerWorkboardCli", () => {
  beforeEach(() => {
    gatewayRuntime.callGatewayFromCli.mockReset();
    gatewayRuntime.getRuntimeConfig.mockReset();
    gatewayRuntime.getRuntimeConfig.mockReturnValue({});
    delete process.env.OPENCLAW_GATEWAY_URL;
  });

  it("redacts claim tokens from card JSON output", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({ title: "Claimed worker", status: "running" });
    await store.claim(card.id, { ownerId: "worker", token: "secret-token" });
    const program = createProgram(store);

    const listOutput = await captureStdout(async () => {
      await program.parseAsync(["workboard", "list", "--json"], { from: "user" });
    });
    const showOutput = await captureStdout(async () => {
      await program.parseAsync(["workboard", "show", card.id, "--json"], { from: "user" });
    });

    expect(listOutput).not.toContain("secret-token");
    expect(showOutput).not.toContain("secret-token");
    expect(listOutput).toContain("[redacted]");
    expect(showOutput).toContain("[redacted]");
  });

  it("hides archived cards from text output by default and reveals them with --include-archived", async () => {
    const store = new WorkboardStore(createMemoryStore());
    await store.create({ title: "Active card" });
    const archived = await store.create({ title: "Archived card" });
    await store.archive(archived.id, true);
    const program = createProgram(store);

    const defaultOutput = await captureStdout(async () => {
      await program.parseAsync(["workboard", "list"], { from: "user" });
    });
    const includeOutput = await captureStdout(async () => {
      await program.parseAsync(["workboard", "list", "--include-archived"], { from: "user" });
    });

    expect(defaultOutput).toContain("Active card");
    expect(defaultOutput).not.toContain("Archived card");
    expect(includeOutput).toContain("Active card");
    expect(includeOutput).toContain("Archived card");
  });

  it("preserves archived cards in JSON list output by default", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const archived = await store.create({ title: "Archived card" });
    await store.archive(archived.id, true);
    const program = createProgram(store);

    const output = await captureStdout(async () => {
      await program.parseAsync(["workboard", "list", "--json"], { from: "user" });
    });

    expect(output).toContain(archived.id);
    expect(output).toContain("archivedAt");
  });

  it("does not fall back to local dispatch for explicit gateway targets", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({ title: "Remote target", status: "ready" });
    const program = createProgram(store);
    gatewayRuntime.callGatewayFromCli.mockRejectedValueOnce(
      new Error("connect ECONNREFUSED 127.0.0.1:18789"),
    );

    await expect(
      program.parseAsync(["workboard", "dispatch", "--url", "ws://remote"], { from: "user" }),
    ).rejects.toThrow("ECONNREFUSED");

    const after = await store.get(card.id);
    expect(after?.status).toBe("ready");
    expect(after?.metadata?.automation?.dispatchCount).toBeUndefined();
  });

  it("does not fall back to local dispatch for configured remote gateways", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({ title: "Configured remote target", status: "ready" });
    const program = createProgram(store);
    gatewayRuntime.getRuntimeConfig.mockReturnValue({
      gateway: { mode: "remote", remote: { url: "wss://gateway.example" } },
    });
    gatewayRuntime.callGatewayFromCli.mockRejectedValueOnce(
      new Error("connect ECONNREFUSED gateway.example:443"),
    );

    await expect(program.parseAsync(["workboard", "dispatch"], { from: "user" })).rejects.toThrow(
      "ECONNREFUSED",
    );

    const after = await store.get(card.id);
    expect(after?.status).toBe("ready");
    expect(after?.metadata?.automation?.dispatchCount).toBeUndefined();
  });

  it("rejects ambiguous card id prefixes", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const prefix = await createAmbiguousPrefix(store);
    const program = createProgram(store);

    await expect(
      program.parseAsync(["workboard", "show", prefix], { from: "user" }),
    ).rejects.toThrow("Ambiguous card id prefix");
  });

  it("moves a card to a different status", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({ title: "Move me", status: "todo" });
    const program = createProgram(store);

    const output = await captureStdout(async () => {
      await program.parseAsync(["workboard", "move", card.id, "--status", "running"], {
        from: "user",
      });
    });
    expect(output).toContain("Move me");
    expect(output).toContain("running");

    const updated = await store.get(card.id);
    expect(updated?.status).toBe("running");
  });

  it("rejects invalid status in move command", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({ title: "Bad move", status: "todo" });
    const program = createProgram(store);

    await expect(
      program.parseAsync(["workboard", "move", card.id, "--status", "nonexistent"], {
        from: "user",
      }),
    ).rejects.toThrow(/must be one of/);
  });

  it("requires --status flag for move command", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({ title: "Missing status", status: "todo" });
    const program = createProgram(store);

    await expect(
      program.parseAsync(["workboard", "move", card.id], { from: "user" }),
    ).rejects.toThrow("--status is required");
  });

  it("outputs JSON for move command with --json", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({ title: "JSON move", status: "todo" });
    const program = createProgram(store);

    const output = await captureStdout(async () => {
      await program.parseAsync(["workboard", "move", card.id, "--status", "review", "--json"], {
        from: "user",
      });
    });
    const parsed = JSON.parse(output);
    expect(parsed.card.status).toBe("review");
    expect(parsed.card.title).toBe("JSON move");
  });

  it("enforces claim scope in store.move() when moving claimed cards", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({ title: "Claimed", status: "todo" });
    // Claim the card
    await store.claim(card.id, { ownerId: "agent-a", token: "tok-a" });
    // Unrelated agent tries to move - should fail
    await expect(
      store.move(card.id, "running", undefined, { ownerId: "agent-b", token: "tok-b" }),
    ).rejects.toThrow(/card is claimed by agent-a/);
    // Same agent can move - should succeed
    const moved = await store.move(card.id, "running", undefined, {
      ownerId: "agent-a",
      token: "tok-a",
    });
    expect(moved.status).toBe("running");
  });

  it("rejects CLI move of claimed card without matching token", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({ title: "Claimed CLI", status: "todo" });
    await store.claim(card.id, { ownerId: "agent-a", token: "tok-a" });
    // CLI without token should fail - scope { ownerId: "cli" } doesn't match claim
    await expect(
      program.parseAsync(["workboard", "move", card.id, "--status", "running"], {
        from: "user",
      }),
    ).rejects.toThrow(/card is claimed by agent-a/);
    // CLI with correct token should succeed
    await expect(
      program.parseAsync(["workboard", "move", card.id, "--status", "done", "--token", "tok-a"], {
        from: "user",
      }),
    ).resolves.toBeUndefined();
    expect(await store.get(card.id)).toMatchObject({ status: "done" });
  });

  it("uses canonical WORKBOARD_STATUSES in move command validation", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({ title: "Status check", status: "todo" });
    const program = createProgram(store);

    // All valid statuses should work (skip scheduled which requires scheduledAt)
    const validStatuses = [
      "triage",
      "backlog",
      "todo",
      "ready",
      "running",
      "review",
      "blocked",
      "done",
    ];
    for (const status of validStatuses) {
      const output = await captureStdout(async () => {
        await program.parseAsync(["workboard", "move", card.id, "--status", status], {
          from: "user",
        });
      });
      expect(output).toContain(card.title);
    }
  });
});
