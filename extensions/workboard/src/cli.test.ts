import { Command } from "commander";
import { assert, beforeEach, describe, expect, it, vi } from "vitest";
import { registerWorkboardCli } from "./cli.js";
import type { WorkboardStore } from "./store.js";
import { createWorkboardSqliteTestStore } from "./test/sqlite-store.js";

const gatewayRuntime = vi.hoisted(() => ({
  callGatewayFromCli: vi.fn(),
  isImplicitLocalGatewayTargetFromCli: vi.fn(async () => false),
}));

vi.mock(import("openclaw/plugin-sdk/gateway-runtime"), async (importOriginal) => ({
  ...(await importOriginal()),
  ...gatewayRuntime,
}));

vi.mock("openclaw/plugin-sdk/cli-state-owner", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/cli-state-owner")>()),
  runWithLocalStateOwner: ({
    runLocal,
  }: {
    runLocal: (scope: { assertCurrent(): void }) => unknown;
  }) => runLocal({ assertCurrent() {} }),
}));

async function captureStdout(run: () => Promise<unknown>): Promise<string> {
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
  const captureCli = (...args: string[]) => captureStdout(() => parse(...args));

  beforeEach(() => {
    store = createWorkboardSqliteTestStore();
    program = new Command().exitOverride().configureOutput({ writeErr() {}, writeOut() {} });
    registerWorkboardCli({ program, withStore: async (action) => action(store) });
    gatewayRuntime.callGatewayFromCli.mockReset();
    gatewayRuntime.isImplicitLocalGatewayTargetFromCli.mockReset().mockResolvedValue(false);
    delete process.env.OPENCLAW_GATEWAY_URL;
  });

  it("rejects invalid list status filters instead of reporting an empty board", async () => {
    const running = await store.create({ title: "Active work", status: "running" });
    await store.create({ title: "Queued work", status: "todo" });
    const output = await captureCli("list", "--status", "running", "--json");
    expect(JSON.parse(output)).toMatchObject({ cards: [{ id: running.id }] });
    await captureStdout(() =>
      expect(parse("list", "--status", "runnning", "--json")).rejects.toThrow(
        /Allowed choices are.*running/,
      ),
    );
  });

  it("requests minimum scopes unless full-host access is explicit", async () => {
    gatewayRuntime.callGatewayFromCli.mockResolvedValue({ started: [], startFailures: [] });
    for (const admin of [false, true]) {
      await parse("dispatch", ...(admin ? ["--admin"] : []));
      const [method, , input, options] = gatewayRuntime.callGatewayFromCli.mock.lastCall!;
      expect(method).toBe("workboard.cards.dispatch");
      expect(input).not.toHaveProperty("maxStarts");
      expect(options).toEqual({
        mode: "cli",
        scopes: [...(admin ? ["operator.admin"] : []), "operator.write", "operator.read"],
      });
    }
  });

  it.each([false, true])("reports each dispatch failure with JSON=%s", async (json) => {
    const result = {
      started: [{ cardId: "started-card", runId: "run-started" }],
      startFailures: [
        { cardId: "12345678-first", error: "offline" },
        { cardId: "abcdef01-second", error: "missing" },
      ],
    };
    gatewayRuntime.callGatewayFromCli.mockResolvedValueOnce(result);
    const output = await captureCli("dispatch", ...(json ? ["--json"] : []));

    if (json) {
      expect(JSON.parse(output)).toEqual(result);
    } else {
      expect(output).toBe(
        "dispatch complete: started=1 failures=2\n12345678: offline\nabcdef01: missing\n",
      );
    }
  });

  it("does not fall back when an older gateway lacks max-starts dispatch", async () => {
    const card = await store.create({ title: "Bounded dispatch", status: "ready" });
    const method = "workboard.cards.dispatchWithOptions";
    gatewayRuntime.callGatewayFromCli.mockRejectedValueOnce(new Error(`unknown method: ${method}`));
    await expect(parse("dispatch", "--max-starts", "1")).rejects.toThrow(
      `unknown method: ${method}`,
    );
    const [calledMethod, , input] = gatewayRuntime.callGatewayFromCli.mock.calls[0]!;
    expect(calledMethod).toBe(method);
    expect(input).toMatchObject({ maxStarts: 1 });
    await expect(store.get(card.id)).resolves.toMatchObject({ status: "ready" });
  });

  it("rejects invalid --max-starts value", async () => {
    await expect(parse("dispatch", "--max-starts", "1e3")).rejects.toThrow(
      "--max-starts must be a positive integer.",
    );
    expect(gatewayRuntime.callGatewayFromCli).not.toHaveBeenCalled();
  });

  it("renders a claimed card through operator move and archival without leaking its token", async () => {
    await captureCli("create", "Claimed card");
    const [card] = await store.list();
    assert(card);
    expect(card.metadata?.automation?.workspaceAccess).toEqual({ unrestricted: true });
    const id = card.id;
    await store.claim(id, { ownerId: "worker", token: "secret-token" });
    for (const args of [["list"], ["show", id]]) {
      const output = await captureCli(...args, "--json");
      expect(output).not.toContain("secret-token");
      expect(output).toContain("[redacted]");
    }
    const output = await captureCli("move", id.slice(0, 8), "--status", "review", "--json");
    const parsed = JSON.parse(output);
    expect(parsed).toMatchObject({ card: { id, status: "review" } });
    expect(parsed.card.metadata.claim.token).toBe("[redacted]");
    expect(output).not.toContain("secret-token");
    await store.archive(id, true);
    await store.create({ title: "Active card" });
    const defaultOutput = await captureCli("list");
    const includeOutput = await captureCli("list", "--include-archived");
    expect(defaultOutput).toContain("Active card");
    expect(defaultOutput).not.toContain("Claimed card");
    expect(includeOutput).toContain("Active card");
    expect(includeOutput).toContain("Claimed card");
    expect(includeOutput).toContain("(archived)");
    const jsonOutput = await captureCli("list", "--json");
    expect(jsonOutput).toContain(id);
    expect(jsonOutput).toContain("archivedAt");
    expect(await captureCli("show", id)).toContain("Claimed card (archived)");
  });
});
