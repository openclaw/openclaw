import { describe, expect, it } from "vitest";
import {
  buildSmolMachineArgv,
  describeSmolMachine,
  formatSmolCliFailure,
  parseSmolMachineList,
  parseSmolMachineStatus,
  smolCommandEnv,
  smolImageReferencesMatch,
} from "./cli.js";
import { resolveSmolPluginConfig } from "./config.js";

const config = resolveSmolPluginConfig(undefined);

describe("smol cli helpers", () => {
  it("builds lifecycle argv around the machine name", () => {
    expect(buildSmolMachineArgv(config, "start", "openclaw-smol-abc", ["--branchable"])).toEqual([
      "smol",
      "machine",
      "start",
      "--name",
      "openclaw-smol-abc",
      "--branchable",
    ]);
  });

  it("keeps a cloud token away from sandbox machines", () => {
    expect(
      smolCommandEnv({ PATH: "/usr/bin", SMOL_CLOUD_TOKEN: "secret", HOME: "/home/op" }),
    ).toEqual({ PATH: "/usr/bin", HOME: "/home/op" });
  });

  it("reads the machine inventory the CLI prints", () => {
    expect(
      parseSmolMachineList(
        JSON.stringify([
          {
            name: "openclaw-smol-1",
            state: "running",
            location: "local",
            source: "python:3.12-slim@sha256:abc",
            labels: { "openclaw.sandbox": "1" },
          },
          { name: "legacy", state: "stopped", image: "debian:bookworm" },
          { name: 7, state: "running" },
          "not-a-machine",
        ]),
      ),
    ).toEqual([
      { name: "openclaw-smol-1", state: "running", image: "python:3.12-slim@sha256:abc" },
      { name: "legacy", state: "stopped", image: "debian:bookworm" },
    ]);
    expect(parseSmolMachineList("not json")).toEqual([]);
    expect(parseSmolMachineList(JSON.stringify({ machines: [] }))).toEqual([]);
  });

  it("reads the machine status the CLI prints", () => {
    expect(
      parseSmolMachineStatus(
        JSON.stringify({ name: "m", running: true, network: false, pid: 42, mounts: 1 }),
      ),
    ).toEqual({ running: true, network: false });
    expect(parseSmolMachineStatus(JSON.stringify({ running: true }))).toBeUndefined();
    expect(parseSmolMachineStatus("[]")).toBeUndefined();
    expect(parseSmolMachineStatus("not json")).toBeUndefined();
  });

  it("lists only local machines when looking one up", async () => {
    const calls: string[][] = [];
    const machine = await describeSmolMachine(
      {
        config,
        run: async (argv) => {
          calls.push(argv);
          return {
            code: 0,
            stdout: JSON.stringify([{ name: "openclaw-smol-1", state: "running" }]),
            stderr: "",
          };
        },
      },
      "openclaw-smol-1",
    );
    expect(calls).toEqual([["smol", "machine", "ls", "--json", "--local"]]);
    expect(machine).toEqual({ name: "openclaw-smol-1", state: "running", image: undefined });
  });

  it("surfaces an inventory failure instead of treating it as a missing machine", async () => {
    await expect(
      describeSmolMachine(
        {
          config,
          run: async () => ({ code: 1, stdout: "", stderr: "engine daemon not running" }),
        },
        "openclaw-smol-1",
      ),
    ).rejects.toThrow("smol machine ls failed: engine daemon not running");
  });

  it("prefers stderr, then stdout, then the exit code when describing a failure", () => {
    expect(formatSmolCliFailure("machine rm", { code: 2, stdout: "out", stderr: " err " })).toBe(
      "smol machine rm failed: err",
    );
    expect(formatSmolCliFailure("machine rm", { code: 2, stdout: "out", stderr: "" })).toBe(
      "smol machine rm failed: out",
    );
    expect(formatSmolCliFailure("machine rm", { code: 2, stdout: "", stderr: "" })).toBe(
      "smol machine rm failed: exit code 2",
    );
  });

  it("matches a configured image against the digest-pinned reference the engine records", () => {
    expect(smolImageReferencesMatch("python:3.12-slim@sha256:abc", "python:3.12-slim")).toBe(true);
    expect(smolImageReferencesMatch("docker.io/library/python:3.12-slim", "python:3.12-slim")).toBe(
      true,
    );
    expect(smolImageReferencesMatch("debian@sha256:abc", "debian:latest")).toBe(true);
    expect(smolImageReferencesMatch("python:3.11-slim", "python:3.12-slim")).toBe(false);
    expect(smolImageReferencesMatch("ghcr.io/acme/python:3.12-slim", "python:3.12-slim")).toBe(
      false,
    );
    expect(smolImageReferencesMatch(undefined, "python:3.12-slim")).toBe(false);
  });
});
