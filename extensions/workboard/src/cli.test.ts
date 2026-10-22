import { Command } from "commander";
import { assert, beforeEach, describe, expect, it, vi } from "vitest";
import { registerWorkboardCli } from "./cli.js";
import type { WorkboardStore } from "./store.js";
import { createAmbiguousPrefix } from "./test/interaction-fixtures.js";
import { createWorkboardSqliteTestStore } from "./test/sqlite-store.js";

const gatewayRuntime = vi.hoisted(() => ({
  callGatewayFromCli: vi.fn(),
  isImplicitLocalGatewayTargetFromCli: vi.fn(async () => false),
}));

vi.mock("openclaw/plugin-sdk/gateway-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/gateway-runtime")>(
    "openclaw/plugin-sdk/gateway-runtime",
  );
  return {
    ...actual,
    callGatewayFromCli: gatewayRuntime.callGatewayFromCli,
    isImplicitLocalGatewayTargetFromCli: gatewayRuntime.isImplicitLocalGatewayTargetFromCli,
  };
});

vi.mock("openclaw/plugin-sdk/cli-state-owner", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/cli-state-owner")>()),
  runWithLocalStateOwner: ({
    runLocal,
  }: {
    runLocal: (scope: { assertCurrent(): void }) => unknown;
  }) => runLocal({ assertCurrent() {} }),
}));

function createProgram(store: WorkboardStore): Command {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({
    writeErr: () => {},
    writeOut: () => {},
  });
  registerWorkboardCli({ program, withStore: async (action) => action(store) });
  return program;
}

async function captureStdout(run: () => Promise<void>): Promise<string> {
  let output = "";
  using _ = vi.spyOn(process.stdout, "write").mockImplementation((chunk): boolean => {
    output += String(chunk);
    return true;
  });
  await run();
  return output;
}

describe("registerWorkboardCli", () => {
  let store: WorkboardStore;
  let program: Command;
  const parse = (...args: string[]) => program.parseAsync(["workboard", ...args], { from: "user" });
  const captureCli = (...args: string[]) =>
    captureStdout(async () => {
      await parse(...args);
    });

  beforeEach(() => {
    store = createWorkboardSqliteTestStore();
    program = createProgram(store);
    gatewayRuntime.callGatewayFromCli.mockReset();
    gatewayRuntime.isImplicitLocalGatewayTargetFromCli.mockReset().mockResolvedValue(false);
    delete process.env.OPENCLAW_GATEWAY_URL;
  });

  it("redacts claim tokens from card JSON output", async () => {
    const card = await store.create({ title: "Claimed worker", status: "running" });
    await store.claim(card.id, { ownerId: "worker", token: "secret-token" });
    const listOutput = await captureCli("list", "--json");
    const showOutput = await captureCli("show", card.id, "--json");
    expect(listOutput).not.toContain("secret-token");
    expect(showOutput).not.toContain("secret-token");
    expect(listOutput).toContain("[redacted]");
    expect(showOutput).toContain("[redacted]");
  });

  it("hides archived cards from text output by default and reveals them with --include-archived", async () => {
    await store.create({ title: "Active card" });
    const archived = await store.create({ title: "Archived card" });
    await store.archive(archived.id, true);
    const defaultOutput = await captureCli("list");
    const includeOutput = await captureCli("list", "--include-archived");
    expect(defaultOutput).toContain("Active card");
    expect(defaultOutput).not.toContain("Archived card");
    expect(includeOutput).toContain("Active card");
    expect(includeOutput).toContain("Archived card");
    expect(includeOutput).toContain("(archived)");
    const jsonOutput = await captureCli("list", "--json");
    expect(jsonOutput).toContain(archived.id);
    expect(jsonOutput).toContain("archivedAt");
    expect(await captureCli("show", archived.id)).toContain("Archived card (archived)");
  });

  it("rejects invalid list status filters instead of reporting an empty board", async () => {
    const running = await store.create({ title: "Active work", status: "running" });
    await store.create({ title: "Queued work", status: "todo" });
    const output = await captureCli("list", "--status", "running", "--json");
    expect(JSON.parse(output)).toMatchObject({ cards: [{ id: running.id }] });
    await captureStdout(async () => {
      await expect(parse("list", "--status", "runnning", "--json")).rejects.toThrow(
        /Allowed choices are.*running/,
      );
    });
  });

  it("requests minimum scopes unless full-host access is explicit", async () => {
    gatewayRuntime.callGatewayFromCli.mockResolvedValue({ started: [], startFailures: [] });
    await parse("dispatch");
    expect(gatewayRuntime.callGatewayFromCli.mock.calls[0]?.[0]).toBe("workboard.cards.dispatch");
    expect(gatewayRuntime.callGatewayFromCli.mock.calls[0]?.[2]).not.toHaveProperty("maxStarts");
    expect(gatewayRuntime.callGatewayFromCli.mock.calls[0]?.[3]).toEqual({
      mode: "cli",
      scopes: ["operator.write", "operator.read"],
    });
    await parse("dispatch", "--admin");
    expect(gatewayRuntime.callGatewayFromCli.mock.calls[1]?.[3]).toEqual({
      mode: "cli",
      scopes: ["operator.admin", "operator.write", "operator.read"],
    });
  });

  it.each([false, true])("reports each dispatch failure with JSON=%s", async (json) => {
    const result = {
      started: [{ cardId: "started-card", runId: "run-started" }],
      startFailures: [
        { cardId: "12345678-first-card", error: "Workspace is unavailable." },
        { cardId: "abcdef01-second-card", error: "Model is unavailable." },
      ],
    };
    gatewayRuntime.callGatewayFromCli.mockResolvedValueOnce(result);
    const output = await captureCli("dispatch", ...(json ? ["--json"] : []));

    if (json) {
      expect(JSON.parse(output)).toEqual(result);
    } else {
      expect(output).toBe(
        "dispatch complete: started=1 failures=2\n" +
          "12345678: Workspace is unavailable.\n" +
          "abcdef01: Model is unavailable.\n",
      );
    }
  });

  it("does not fall back when an older gateway lacks max-starts dispatch", async () => {
    const card = await store.create({ title: "Bounded dispatch", status: "ready" });
    gatewayRuntime.callGatewayFromCli.mockRejectedValueOnce(
      new Error("unknown method: workboard.cards.dispatchWithOptions"),
    );
    await expect(parse("dispatch", "--max-starts", "1")).rejects.toThrow(
      "unknown method: workboard.cards.dispatchWithOptions",
    );
    expect(gatewayRuntime.callGatewayFromCli).toHaveBeenCalledWith(
      "workboard.cards.dispatchWithOptions",
      expect.anything(),
      expect.objectContaining({ maxStarts: 1 }),
      expect.anything(),
    );
    await expect(store.get(card.id)).resolves.toMatchObject({ status: "ready" });
  });

  it.each(["1e3"])("rejects invalid --max-starts value %s", async (value) => {
    await expect(parse("dispatch", "--max-starts", value)).rejects.toThrow(
      "--max-starts must be a positive integer.",
    );
    expect(gatewayRuntime.callGatewayFromCli).not.toHaveBeenCalled();
  });

  it("rejects ambiguous card id prefixes", async () => {
    const prefix = await createAmbiguousPrefix(store);
    await expect(parse("show", prefix)).rejects.toThrow("Ambiguous card id prefix");
  });

  it("moves claimed cards with operator authority and redacts JSON output", async () => {
    await captureCli("create", "Claimed card");
    const [card] = await store.list();
    assert(card);
    expect(card.metadata?.automation?.workspaceAccess).toEqual({ unrestricted: true });
    const id = card.id;
    await store.claim(id, { ownerId: "worker", token: "secret-token" });
    const output = await captureCli("move", id.slice(0, 8), "--status", "review", "--json");
    const parsed = JSON.parse(output);
    expect(parsed).toMatchObject({ card: { id, status: "review" } });
    expect(parsed.card.metadata.claim.token).toBe("[redacted]");
    expect(output).not.toContain("secret-token");
  });
});
