import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerMatrixDirectCommands } from "./cli-direct.js";

const mocks = vi.hoisted(() => ({
  inspect: vi.fn(),
  repair: vi.fn(),
  resolved: vi.fn(),
  started: vi.fn(),
  log: vi.fn(),
}));
const cfg = { channels: { matrix: { encryption: true } } };
const client = {};

vi.mock("./runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./runtime.js")>()),
  getMatrixRuntime: () => ({ config: { current: () => cfg } }),
}));
vi.mock("./matrix/account-config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./matrix/account-config.js")>()),
  resolveMatrixAccountConfig: () => ({ encryption: true }),
}));
vi.mock("./matrix/actions/client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./matrix/actions/client.js")>()),
  withResolvedActionClient: mocks.resolved,
  withStartedActionClient: mocks.started,
}));
vi.mock("./matrix/direct-management.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./matrix/direct-management.js")>()),
  inspectMatrixDirectRooms: mocks.inspect,
  repairMatrixDirectRooms: mocks.repair,
}));
vi.mock("./cli-shared.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./cli-shared.js")>()),
  resolveMatrixCliAccountContext: (accountId: string) => ({ accountId }),
  runMatrixCliCommand: async (
    options: { verbose?: boolean; json?: boolean },
    command: { run: () => Promise<unknown>; onText: (result: unknown, verbose: boolean) => void },
  ) => {
    const result = await command.run();
    if (options.json) {
      console.log(JSON.stringify(result));
    } else {
      command.onText(result, options.verbose === true);
    }
  },
  printAccountLabel: (accountId: string) => console.log(`Account: ${accountId}`),
  formatMatrixCliText: (value: string | null | undefined, fallback = "unknown") =>
    value ?? fallback,
}));

const inspection = {
  selfUserId: "@bot:example.org",
  remoteUserId: "@peer:example.org",
  mappedRoomIds: ["!dm:example.org"],
  mappedRooms: [
    {
      roomId: "!dm:example.org",
      source: "account-data",
      strict: true,
      explicit: true,
      joinedMembers: null,
    },
  ],
  discoveredStrictRoomIds: [],
  activeRoomId: "!dm:example.org",
};

async function run(name: string, ...args: string[]) {
  const program = new Command();
  registerMatrixDirectCommands(program);
  await program.parseAsync(
    ["direct", name, "--account", "ops", "--user-id", "@peer:example.org", ...args],
    { from: "user" },
  );
}

describe("Matrix direct-room CLI", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "log").mockImplementation(mocks.log);
    mocks.resolved.mockImplementation(async (_opts, operation) => operation(client));
    mocks.started.mockImplementation(async (_opts, operation) => operation(client));
    mocks.inspect.mockResolvedValue(inspection);
    mocks.repair.mockResolvedValue({
      ...inspection,
      createdRoomId: null,
      changed: true,
      directContentBefore: {},
      directContentAfter: { "@peer:example.org": ["!dm:example.org"] },
    });
  });
  afterEach(() => vi.restoreAllMocks());

  it("inspects without starting the client and keeps the CLI projection private", async () => {
    await run("inspect", "--json");
    expect(mocks.resolved).toHaveBeenCalledWith({ accountId: "ops", cfg }, expect.any(Function));
    expect(mocks.started).not.toHaveBeenCalled();
    expect(mocks.inspect).toHaveBeenCalledWith({ client, remoteUserId: "@peer:example.org" });
    expect(mocks.repair).not.toHaveBeenCalled();
    const result = JSON.parse(mocks.log.mock.calls[0]?.[0]);
    expect(result.accountId).toBe("ops");
    expect(result.mappedRooms).toEqual([
      { roomId: "!dm:example.org", source: "account-data", strict: true, joinedMembers: null },
    ]);
    expect(result).not.toHaveProperty("encrypted");
  });

  it("starts the repair client, preserves encryption, and prints repair details", async () => {
    await run("repair", "--verbose");
    expect(mocks.started).toHaveBeenCalledWith({ accountId: "ops", cfg }, expect.any(Function));
    expect(mocks.resolved).not.toHaveBeenCalled();
    expect(mocks.repair).toHaveBeenCalledWith({
      client,
      remoteUserId: "@peer:example.org",
      encrypted: true,
    });
    expect(mocks.inspect).not.toHaveBeenCalled();
    expect(mocks.log).toHaveBeenCalledWith("Encrypted room creation: enabled");
    expect(mocks.log).toHaveBeenCalledWith("Created room: none");
    expect(mocks.log).toHaveBeenCalledWith("m.direct updated: yes");
    expect(mocks.log).toHaveBeenCalledWith('m.direct after: ["!dm:example.org"]');
  });
});
