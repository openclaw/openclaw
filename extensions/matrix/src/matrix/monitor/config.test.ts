import { describe, expect, it, vi } from "vitest";
import { createRuntimeSpies } from "../../../../test-support/runtime-spies.js";
import type { CoreConfig, MatrixRoomConfig } from "../../types.js";
import { resolveMatrixMonitorConfig, resolveMatrixMonitorLiveUserAllowlist } from "./config.js";

type MatrixRoomsConfig = Record<string, MatrixRoomConfig>;

function createConfig(params?: { dangerouslyAllowNameMatching?: boolean }): CoreConfig {
  return {
    channels: { matrix: { dangerouslyAllowNameMatching: params?.dangerouslyAllowNameMatching } },
  } as CoreConfig;
}

function resolveNames(ids: Partial<Record<"user" | "group", Record<string, string>>>) {
  return vi.fn(async ({ kind, inputs }: { kind: "user" | "group"; inputs: string[] }) =>
    inputs.map((input) => {
      const id = ids[kind]?.[input];
      return id ? { input, resolved: true, id } : { input, resolved: false };
    }),
  );
}

function expectResolveTargetCall(
  resolveTargets: { mock: { calls: unknown[][] } },
  index: number,
  kind: string,
  inputs: string[],
) {
  expect(resolveTargets.mock.calls[index]?.[0]).toMatchObject({ accountId: "ops", kind, inputs });
}

function resolveConfig(params: Partial<Parameters<typeof resolveMatrixMonitorConfig>[0]>) {
  return resolveMatrixMonitorConfig({
    cfg: createConfig(),
    accountId: "ops",
    runtime: createRuntimeSpies(),
    ...params,
  });
}

function resolveLive(params: Partial<Parameters<typeof resolveMatrixMonitorLiveUserAllowlist>[0]>) {
  return resolveMatrixMonitorLiveUserAllowlist({
    cfg: createConfig(),
    accountId: "ops",
    runtime: createRuntimeSpies(),
    ...params,
  });
}

describe("resolveMatrixMonitorConfig", () => {
  it("canonicalizes resolved user aliases and room keys without keeping stale aliases", async () => {
    const resolveTargets = resolveNames({
      user: { Bob: "@bob:example.org", Dana: "@dana:example.org" },
      group: { General: "!general:example.org" },
    });

    const roomsConfig: MatrixRoomsConfig = {
      "*": { enabled: true },
      "room:!UIZ0YzC99dC1AyEM6mGl0_XNP8u8xeCCt_Zk8Uhkp70": {
        enabled: true,
        users: ["Dana", "user:@Erin:Example.org"],
      },
      General: { enabled: true },
    };

    const result = await resolveConfig({
      cfg: createConfig({ dangerouslyAllowNameMatching: true }),
      allowFrom: ["matrix:@Alice:Example.org", "Bob"],
      groupAllowFrom: ["user:@Carol:Example.org"],
      roomsConfig,
      resolveTargets,
    });

    expect(result.allowFrom).toEqual(["@Alice:Example.org", "@bob:example.org"]);
    expect(result.groupAllowFrom).toEqual(["@Carol:Example.org"]);
    expect(result.roomsConfig).toEqual({
      "*": { enabled: true },
      "!UIZ0YzC99dC1AyEM6mGl0_XNP8u8xeCCt_Zk8Uhkp70": {
        enabled: true,
        users: ["@dana:example.org", "@Erin:Example.org"],
      },
      "!general:example.org": { enabled: true },
    });
    expect(resolveTargets).toHaveBeenCalledTimes(3);
    expectResolveTargetCall(resolveTargets, 0, "user", ["Bob"]);
    expectResolveTargetCall(resolveTargets, 1, "group", ["General"]);
    expectResolveTargetCall(resolveTargets, 2, "user", ["Dana"]);
  });

  it("strips config prefixes before lookups and logs unresolved guidance once per section", async () => {
    const runtime = createRuntimeSpies();
    const resolveTargets = vi.fn(
      async ({ kind, inputs }: { inputs: string[]; kind: "user" | "group" }) =>
        inputs.map((input) => ({
          input,
          resolved: false,
          ...(kind === "group" ? { note: `missing ${input}` } : {}),
        })),
    );

    const result = await resolveConfig({
      cfg: createConfig({ dangerouslyAllowNameMatching: true }),
      allowFrom: ["user:Ghost"],
      groupAllowFrom: ["matrix:@known:example.org"],
      roomsConfig: {
        "!": { enabled: true },
        "channel:Project X": { enabled: true, users: ["matrix:Ghost"] },
      },
      runtime,
      resolveTargets,
    });

    expect(result.allowFrom).toStrictEqual([]);
    expect(result.groupAllowFrom).toEqual(["@known:example.org"]);
    expect(result.roomsConfig).toStrictEqual({});
    expectResolveTargetCall(resolveTargets, 0, "user", ["Ghost"]);
    expectResolveTargetCall(resolveTargets, 1, "group", ["!", "Project X"]);
    expect(resolveTargets).toHaveBeenCalledTimes(2);
    expect(runtime.log).toHaveBeenCalledWith("matrix dm allowlist unresolved: user:Ghost");
    expect(runtime.log).toHaveBeenCalledWith(
      "matrix dm allowlist entries must be full Matrix IDs (example: @user:server). Unresolved entries will not match any sender.",
    );
    expect(runtime.log).toHaveBeenCalledWith("matrix rooms unresolved: !, channel:Project X");
    expect(runtime.log).toHaveBeenCalledWith(
      "matrix rooms must be room IDs or aliases (example: !room:server, the suffixless !room form on room version 12+, or #alias:server). Unresolved entries are ignored.",
    );
  });

  it("resolves exact room aliases to canonical room ids instead of trusting alias keys directly", async () => {
    const resolveTargets = resolveNames({
      group: { "#allowed:example.org": "!allowed-room:example.org" },
    });

    const result = await resolveConfig({
      cfg: createConfig({ dangerouslyAllowNameMatching: true }),
      roomsConfig: { "#allowed:example.org": { enabled: true } },
      resolveTargets,
    });

    expect(result.roomsConfig).toEqual({ "!allowed-room:example.org": { enabled: true } });
    expectResolveTargetCall(resolveTargets, 0, "group", ["#allowed:example.org"]);
  });

  it("does not resolve mutable allowlist entries or room names by default", async () => {
    const runtime = createRuntimeSpies();
    const resolveTargets = vi.fn(
      async ({ kind, inputs }: { inputs: string[]; kind: "user" | "group" }) => {
        if (kind === "group") {
          return inputs.map((input) =>
            input === "#ops:example.org"
              ? { input, resolved: true, id: "!ops:example.org" }
              : { input, resolved: false },
          );
        }
        return inputs.map((input) => ({ input, resolved: true, id: `@${input}:example.org` }));
      },
    );

    const result = await resolveConfig({
      allowFrom: ["Alice", "matrix:@Bob:Example.org"],
      groupAllowFrom: ["Carol"],
      roomsConfig: {
        General: { enabled: true, users: ["Dana"] },
        "#ops:example.org": { enabled: true, users: ["user:@Erin:Example.org", "Frank"] },
      },
      runtime,
      resolveTargets,
    });

    expect(result.allowFrom).toEqual(["@Bob:Example.org"]);
    expect(result.allowFromResolvedEntries).toEqual([
      { input: "matrix:@Bob:Example.org", id: "@Bob:Example.org" },
    ]);
    expect(result.groupAllowFrom).toEqual(["Carol"]);
    expect(result.roomsConfig).toEqual({
      "!ops:example.org": { enabled: true, users: ["@Erin:Example.org", "Frank"] },
    });
    expect(resolveTargets).toHaveBeenCalledTimes(1);
    expectResolveTargetCall(resolveTargets, 0, "group", ["#ops:example.org"]);
    expect(runtime.log).toHaveBeenCalledWith("matrix dm allowlist unresolved: Alice");
    expect(runtime.log).toHaveBeenCalledWith(
      "matrix dm allowlist entries must be full Matrix IDs (example: @user:server). Unresolved entries will not match any sender. To match Matrix display names, set channels.matrix.dangerouslyAllowNameMatching=true.",
    );
    expect(runtime.log).toHaveBeenCalledWith("matrix group allowlist unresolved: Carol");
    expect(runtime.log).toHaveBeenCalledWith(
      "matrix group allowlist entries must be full Matrix IDs (example: @user:server). Unresolved entries will not match any sender. To match Matrix display names, set channels.matrix.dangerouslyAllowNameMatching=true.",
    );
    expect(runtime.log).toHaveBeenCalledWith("matrix room users unresolved: Frank");
    expect(runtime.log).toHaveBeenCalledWith(
      "matrix room users entries must be full Matrix IDs (example: @user:server). Unresolved entries will not match any sender. To match Matrix display names, set channels.matrix.dangerouslyAllowNameMatching=true.",
    );
  });

  it("keeps case-distinct qualified user ids in startup allowlists", async () => {
    const resolveTargets = vi.fn(async () => []);
    const caseDistinctIds = ["@alice:Example.org", "@alice:example.org"];

    const result = await resolveConfig({
      allowFrom: caseDistinctIds,
      groupAllowFrom: caseDistinctIds,
      roomsConfig: { "!ops:example.org": { enabled: true, users: caseDistinctIds } },
      resolveTargets,
    });

    expect(result.allowFrom).toEqual(caseDistinctIds);
    expect(result.groupAllowFrom).toEqual(caseDistinctIds);
    expect(result.roomsConfig).toEqual({
      "!ops:example.org": { enabled: true, users: caseDistinctIds },
    });
    expect(resolveTargets).not.toHaveBeenCalled();
  });

  it("keeps case-distinct qualified user ids in live allowlists", async () => {
    const resolveTargets = vi.fn(async () => []);
    const caseDistinctIds = ["@alice:Example.org", "@alice:example.org"];

    const result = await resolveLive({ entries: caseDistinctIds, resolveTargets });

    expect(result).toEqual(caseDistinctIds);
    expect(resolveTargets).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "default",
      nameMatching: false,
      failClosed: false,
      expected: ["@Bob:Example.org", "*"],
    },
    {
      name: "fail-closed group",
      nameMatching: false,
      failClosed: true,
      expected: ["Alice", "@Bob:Example.org"],
    },
    {
      name: "name matching",
      nameMatching: true,
      failClosed: false,
      expected: ["@Bob:Example.org", "*", "@alice:example.org"],
    },
  ])(
    "resolves live allowlists with $name policy",
    async ({ nameMatching, failClosed, expected }) => {
      const resolveTargets = resolveNames({ user: { Alice: "@alice:example.org" } });
      const result = await resolveLive({
        cfg: createConfig({ dangerouslyAllowNameMatching: nameMatching }),
        entries: ["Alice", "matrix:@Bob:Example.org", ...(failClosed ? [] : ["*"])],
        failClosedOnUnresolved: failClosed,
        ...(nameMatching
          ? {}
          : { startupResolvedEntries: [{ input: "Alice", id: "@startup-alice:example.org" }] }),
        resolveTargets,
      });
      expect(result).toEqual(expected);
      if (nameMatching) {
        expectResolveTargetCall(resolveTargets, 0, "user", ["Alice"]);
      } else {
        expect(resolveTargets).not.toHaveBeenCalled();
      }
    },
  );
});
