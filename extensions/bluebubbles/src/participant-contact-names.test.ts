import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  enrichBlueBubblesParticipantsWithContactNames,
  listBlueBubblesContactsDatabasesForTest,
  queryBlueBubblesContactsDatabaseForTest,
  resetBlueBubblesParticipantContactNameCacheForTest,
  resolveBlueBubblesParticipantContactNamesFromMacOsContactsForTest,
} from "./participant-contact-names.js";

describe("enrichBlueBubblesParticipantsWithContactNames", () => {
  beforeEach(() => {
    resetBlueBubblesParticipantContactNameCacheForTest();
  });

  it("enriches unnamed phone participants and reuses cached names across formats", async () => {
    const resolver = vi.fn(
      async (phoneKeys: string[]) =>
        new Map(
          phoneKeys.map((phoneKey) => [
            phoneKey,
            phoneKey === "5551234567" ? "Alice Example" : "Bob Example",
          ]),
        ),
    );

    const first = await enrichBlueBubblesParticipantsWithContactNames(
      [{ id: "+1 (555) 123-4567" }, { id: "+15557654321" }],
      {
        platform: "darwin",
        now: () => 1_000,
        resolvePhoneNames: resolver,
      },
    );

    expect(first).toEqual([
      { id: "+1 (555) 123-4567", name: "Alice Example" },
      { id: "+15557654321", name: "Bob Example" },
    ]);
    expect(resolver).toHaveBeenCalledTimes(1);
    expect(resolver).toHaveBeenCalledWith(["5551234567", "5557654321"]);

    const secondResolver = vi.fn(async () => new Map<string, string>());
    const second = await enrichBlueBubblesParticipantsWithContactNames([{ id: "+15551234567" }], {
      platform: "darwin",
      now: () => 2_000,
      resolvePhoneNames: secondResolver,
    });

    expect(second).toEqual([{ id: "+15551234567", name: "Alice Example" }]);
    expect(secondResolver).not.toHaveBeenCalled();
  });

  it("retries negative cache entries after the short negative ttl expires", async () => {
    const firstResolver = vi.fn(async () => new Map<string, string>());
    const secondResolver = vi.fn(async () => new Map([["5551234567", "Alice Example"]]));

    const first = await enrichBlueBubblesParticipantsWithContactNames([{ id: "+15551234567" }], {
      platform: "darwin",
      now: () => 1_000,
      resolvePhoneNames: firstResolver,
    });
    const second = await enrichBlueBubblesParticipantsWithContactNames([{ id: "+15551234567" }], {
      platform: "darwin",
      now: () => 1_500,
      resolvePhoneNames: secondResolver,
    });
    const third = await enrichBlueBubblesParticipantsWithContactNames([{ id: "+15551234567" }], {
      platform: "darwin",
      now: () => 1_000 + 6 * 60 * 1000,
      resolvePhoneNames: secondResolver,
    });

    expect(first).toEqual([{ id: "+15551234567" }]);
    expect(second).toEqual([{ id: "+15551234567" }]);
    expect(third).toEqual([{ id: "+15551234567", name: "Alice Example" }]);
    expect(firstResolver).toHaveBeenCalledTimes(1);
    expect(secondResolver).toHaveBeenCalledTimes(1);
  });

  it("skips email addresses and keeps existing participant names", async () => {
    const resolver = vi.fn(async () => new Map<string, string>());

    const participants = await enrichBlueBubblesParticipantsWithContactNames(
      [{ id: "alice@example.com" }, { id: "+15551234567", name: "Alice Existing" }],
      {
        platform: "darwin",
        now: () => 1_000,
        resolvePhoneNames: resolver,
      },
    );

    expect(participants).toEqual([
      { id: "alice@example.com" },
      { id: "+15551234567", name: "Alice Existing" },
    ]);
    expect(resolver).not.toHaveBeenCalled();
  });

  it("gracefully returns original participants when lookup fails", async () => {
    const participants = [{ id: "+15551234567" }, { id: "+15557654321" }];

    await expect(
      enrichBlueBubblesParticipantsWithContactNames(participants, {
        platform: "darwin",
        now: () => 1_000,
        resolvePhoneNames: vi.fn(async () => {
          throw new Error("contacts unavailable");
        }),
      }),
    ).resolves.toBe(participants);
  });

  it("lists contacts databases from the current home directory", async () => {
    const homeDir = "/Users/tester";
    const sourcesDir = join(homeDir, "Library", "Application Support", "AddressBook", "Sources");
    const expectedDbPath = join(sourcesDir, "source-a", "AddressBook-v22.abcddb");

    const readdir = vi.fn(async () => ["source-a", "source-b"]);
    const access = vi.fn(async (p: string) => {
      const normalized = p.replaceAll("\\", "/");
      if (!normalized.endsWith("source-a/AddressBook-v22.abcddb")) {
        throw new Error("missing");
      }
    });

    const databases = await listBlueBubblesContactsDatabasesForTest({
      homeDir,
      readdir,
      access,
    });

    expect(readdir).toHaveBeenCalledWith(sourcesDir);
    expect(databases).toEqual([expectedDbPath]);
  });

  it("queries only the requested phone keys in sqlite", async () => {
    const execFileAsync = vi.fn(async (_file: string, _args: string[], _options: unknown) => ({
      stdout: "5551234567\tAlice Example\n5557654321\tBob Example\n",
      stderr: "",
    }));

    const rows = await queryBlueBubblesContactsDatabaseForTest(
      "/tmp/AddressBook-v22.abcddb",
      ["5551234567", "5557654321"],
      { execFileAsync, sqliteDotParameterSupported: true },
    );

    expect(rows).toEqual([
      { phoneKey: "5551234567", name: "Alice Example" },
      { phoneKey: "5557654321", name: "Bob Example" },
    ]);
    expect(execFileAsync).toHaveBeenCalledTimes(1);

    const args = execFileAsync.mock.calls[0]?.[1] ?? [];
    const sql = args[args.length - 1];
    expect(sql).toContain("WHERE digits IN (?1, ?2)");
    expect(args).toContain("-cmd");
    expect(args).toContain(".parameter set ?1 '5551234567'");
    expect(args).toContain(".parameter set ?2 '5557654321'");
  });

  it("uses digit-only SQL literals when sqlite dot-parameter commands are unavailable", async () => {
    const execFileAsync = vi.fn(async (_file: string, _args: string[], _options: unknown) => ({
      stdout: "5551234567\tAlice Example\n5557654321\tBob Example\n",
      stderr: "",
    }));

    const rows = await queryBlueBubblesContactsDatabaseForTest(
      "/tmp/AddressBook-v22.abcddb",
      ["5551234567", "5557654321"],
      { execFileAsync, sqliteDotParameterSupported: false },
    );

    expect(rows).toEqual([
      { phoneKey: "5551234567", name: "Alice Example" },
      { phoneKey: "5557654321", name: "Bob Example" },
    ]);
    expect(execFileAsync).toHaveBeenCalledTimes(1);

    const args = execFileAsync.mock.calls[0]?.[1] ?? [];
    const sql = args[args.length - 1];
    expect(sql).toContain("WHERE digits IN ('5551234567', '5557654321')");
    expect(args.filter((a) => a === "-cmd")).toHaveLength(0);
  });

  it("normalizes fallback SQL literals before interpolation", async () => {
    const execFileAsync = vi.fn(async (_file: string, _args: string[], _options: unknown) => ({
      stdout: "5551234567\tAlice Example\n",
      stderr: "",
    }));

    const rows = await queryBlueBubblesContactsDatabaseForTest(
      "/tmp/AddressBook-v22.abcddb",
      ["+1 (555) 123-4567'); DROP TABLE ZABCDRECORD; --"],
      { execFileAsync, sqliteDotParameterSupported: false },
    );

    expect(rows).toEqual([{ phoneKey: "5551234567", name: "Alice Example" }]);

    const args = execFileAsync.mock.calls[0]?.[1] ?? [];
    const sql = args[args.length - 1];
    expect(sql).toContain("WHERE digits IN ('5551234567')");
    expect(sql).not.toContain("DROP TABLE");
  });

  it("probes sqlite --version once when dot-parameter support is unknown", async () => {
    const execFileAsync = vi.fn(async (_file: string, args: string[]) => {
      if (args[0] === "--version") {
        return { stdout: "3.28.0 2019-04-15 14:59:49 UTC\n", stderr: "" };
      }
      return {
        stdout: "5551234567\tAlice Example\n",
        stderr: "",
      };
    });

    const deps = { execFileAsync };

    await queryBlueBubblesContactsDatabaseForTest("/tmp/a.abcddb", ["5551234567"], deps);
    await queryBlueBubblesContactsDatabaseForTest("/tmp/b.abcddb", ["5551234567"], deps);

    expect(execFileAsync).toHaveBeenCalledTimes(3);
    expect(execFileAsync.mock.calls[0]?.[1]?.[0]).toBe("--version");

    const firstQueryArgs = execFileAsync.mock.calls[1]?.[1] ?? [];
    expect(firstQueryArgs[firstQueryArgs.length - 1]).toContain("WHERE digits IN ('5551234567')");

    const secondQueryArgs = execFileAsync.mock.calls[2]?.[1] ?? [];
    expect(secondQueryArgs[secondQueryArgs.length - 1]).toContain("WHERE digits IN ('5551234567')");
  });

  it("uses sqlite dot parameters after a supported version probe", async () => {
    const execFileAsync = vi.fn(async (_file: string, args: string[]) => {
      if (args[0] === "--version") {
        return { stdout: "3.31.0 2020-01-22 18:38:59 UTC\n", stderr: "" };
      }
      return {
        stdout: "5551234567\tAlice Example\n",
        stderr: "",
      };
    });

    const rows = await queryBlueBubblesContactsDatabaseForTest(
      "/tmp/AddressBook-v22.abcddb",
      ["5551234567"],
      { execFileAsync },
    );

    expect(rows).toEqual([{ phoneKey: "5551234567", name: "Alice Example" }]);
    expect(execFileAsync).toHaveBeenCalledTimes(2);

    const queryArgs = execFileAsync.mock.calls[1]?.[1] ?? [];
    const sql = queryArgs[queryArgs.length - 1];
    expect(sql).toContain("WHERE digits IN (?1)");
    expect(queryArgs).toContain(".parameter set ?1 '5551234567'");
  });

  it("resolves names through the macOS contacts path across multiple databases", async () => {
    const readdir = vi.fn(async () => ["source-a", "source-b"]);
    const access = vi.fn(async () => undefined);
    const execFileAsync = vi
      .fn(async (_file: string, _args: string[], _options: unknown) => ({
        stdout: "",
        stderr: "",
      }))
      .mockResolvedValueOnce({ stdout: "5551234567\tAlice Example\n", stderr: "" })
      .mockResolvedValueOnce({ stdout: "5557654321\tBob Example\n", stderr: "" });

    const resolved = await resolveBlueBubblesParticipantContactNamesFromMacOsContactsForTest(
      ["5551234567", "5557654321"],
      {
        homeDir: "/Users/tester",
        readdir,
        access,
        execFileAsync,
        sqliteDotParameterSupported: true,
      },
    );

    expect([...resolved.entries()]).toEqual([
      ["5551234567", "Alice Example"],
      ["5557654321", "Bob Example"],
    ]);
    expect(execFileAsync).toHaveBeenCalledTimes(2);
  });

  it("skips contact lookup on non macOS hosts", async () => {
    const participants = [{ id: "+15551234567" }];

    const result = await enrichBlueBubblesParticipantsWithContactNames(participants, {
      platform: "linux",
    });

    expect(result).toBe(participants);
  });
});
