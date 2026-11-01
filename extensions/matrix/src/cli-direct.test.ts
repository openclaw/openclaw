import { Command } from "commander";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
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
  runMatrixCliCommand: (async (options, command) => {
    const result = await command.run();
    return options.json
      ? console.log(JSON.stringify(result))
      : command.onText(result, options.verbose === true);
  }) satisfies typeof import("./cli-shared.js").runMatrixCliCommand,
}));

const room = {
  roomId: "!dm:example.org",
  source: "account-data",
  strict: true,
  joinedMembers: null,
};
const inspection = {
  selfUserId: "@bot:example.org",
  remoteUserId: "@peer:example.org",
  mappedRoomIds: ["!dm:example.org"],
  mappedRooms: [{ ...room, explicit: true }],
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

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "log").mockImplementation(mocks.log);
  for (const mock of [mocks.resolved, mocks.started]) {
    mock.mockImplementation(async (_opts, operation) => operation(client));
  }
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

it.each(["inspect", "repair"] as const)("%s client lifecycle and projection", async (name) => {
  const repair = name === "repair";
  await run(name, repair ? "--verbose" : "--json");
  expect(repair ? mocks.started : mocks.resolved).toHaveBeenCalledWith(
    { accountId: "ops", cfg },
    expect.any(Function),
  );
  expect(repair ? mocks.resolved : mocks.started).not.toHaveBeenCalled();
  expect(repair ? mocks.repair : mocks.inspect).toHaveBeenCalledWith({
    client,
    remoteUserId: "@peer:example.org",
    ...(repair ? { encrypted: true } : {}),
  });
  expect(repair ? mocks.inspect : mocks.repair).not.toHaveBeenCalled();
  if (!repair) {
    const result = JSON.parse(mocks.log.mock.calls[0]?.[0]);
    expect(result).toMatchObject({ accountId: "ops" });
    expect(result.mappedRooms).toEqual([room]);
    expect(result).not.toHaveProperty("encrypted");
  } else {
    expect(mocks.log.mock.calls).toEqual(
      expect.arrayContaining([
        ["Encrypted room creation: enabled"],
        ["Created room: none"],
        ["m.direct updated: yes"],
        ['m.direct after: ["!dm:example.org"]'],
      ]),
    );
  }
});
