import { Command } from "commander";
import { describe, expect, test } from "vitest";
import { registerDashboardCli } from "../src/command.js";

function buildProgram(): Command {
  const program = new Command();
  program.exitOverride();
  registerDashboardCli(program);
  return program;
}

describe("registerDashboardCli", () => {
  test("registers all four verbs", () => {
    const program = buildProgram();
    const dashboard = program.commands.find((c) => c.name() === "dashboard");
    expect(dashboard).toBeDefined();
    const verbs = (dashboard?.commands ?? []).map((c) => c.name()).toSorted();
    expect(verbs).toEqual(["logs", "start", "status", "stop"]);
  });

  test("dashboard --help lists every verb", () => {
    const program = buildProgram();
    const dashboard = program.commands.find((c) => c.name() === "dashboard");
    const helpText = dashboard?.helpInformation() ?? "";
    expect(helpText).toContain("start");
    expect(helpText).toContain("stop");
    expect(helpText).toContain("status");
    expect(helpText).toContain("logs");
  });

  test("start accepts --port, --adopt, --public, --dev flags", () => {
    const program = buildProgram();
    const start = program.commands
      .find((c) => c.name() === "dashboard")
      ?.commands.find((c) => c.name() === "start");
    const flags = (start?.options ?? []).map((o) => o.long);
    expect(flags).toEqual(expect.arrayContaining(["--port", "--adopt", "--public", "--dev"]));
  });

  test("logs accepts --follow, --lines, --err flags", () => {
    const program = buildProgram();
    const logs = program.commands
      .find((c) => c.name() === "dashboard")
      ?.commands.find((c) => c.name() === "logs");
    const flags = (logs?.options ?? []).map((o) => o.long);
    expect(flags).toEqual(expect.arrayContaining(["--follow", "--lines", "--err"]));
  });
});
