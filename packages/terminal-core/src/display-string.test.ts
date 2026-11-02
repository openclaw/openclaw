import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderTable } from "./table.js";

function stubHome(home: string, openclawHome = ""): void {
  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", "");
  vi.stubEnv("OPENCLAW_HOME", openclawHome);
}

function displayString(input: string): string | undefined {
  return renderTable({
    columns: [{ key: "value", header: "Path" }],
    rows: [{ value: input }],
  })
    .split("\n")[3]
    ?.slice(2, -2)
    .trimEnd();
}

describe("renderTable home display", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("shortens whole-value homes and child paths without clipping sibling prefixes", () => {
    const home = path.resolve("test-home", "alice");
    stubHome(home);

    expect(displayString(home)).toBe("~");
    expect(displayString(`${home}/project`)).toBe("~/project");
    expect(displayString(`${home}\\project`)).toBe("~\\project");
    expect(displayString(`Workspace: ${home}/project`)).toBe("Workspace: ~/project");
    expect(displayString(`${home}/one ${home}/two`)).toBe("~/one ~/two");
    expect(displayString(`Home: ${home},`)).toBe("Home: ~,");
    expect(displayString(`(${home})`)).toBe("(~)");
    expect(displayString(`${home}.`)).toBe("~.");

    expect(displayString(`${home}2/project`)).toBe(`${home}2/project`);
    expect(displayString(`${home},backup`)).toBe(`${home},backup`);
    expect(displayString(`${home} backup/project`)).toBe(`${home} backup/project`);
    expect(displayString(`${home}../project`)).toBe(`${home}../project`);
    expect(displayString(`prefix${home}/project`)).toBe(`prefix${home}/project`);
    expect(displayString(`/tmp${home}/project`)).toBe(`/tmp${home}/project`);
  });

  it("uses OPENCLAW_HOME as the display prefix", () => {
    const home = path.resolve("test-home", "alice");
    const openclawHome = path.resolve("test-openclaw-home");
    stubHome(home, openclawHome);

    expect(displayString(openclawHome)).toBe("$OPENCLAW_HOME");
    expect(displayString(`${openclawHome}/state`)).toBe("$OPENCLAW_HOME/state");
    expect(displayString(`${openclawHome}2/state`)).toBe(`${openclawHome}2/state`);
  });

  it("keeps replacement syntax literal when expanding OPENCLAW_HOME", () => {
    const home = path.resolve("test-home", "$&user");
    stubHome(home, "~/state");

    expect(displayString(path.join(home, "state", "project"))).toBe(
      `$OPENCLAW_HOME${path.sep}project`,
    );
  });

  it.skipIf(process.platform !== "win32")(
    "shortens real Windows home casing aliases inside table display text",
    () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-home-display-"));
      try {
        const homeAlias = home.toUpperCase();
        expect(fs.statSync(homeAlias).isDirectory()).toBe(true);
        stubHome(home);

        expect(displayString(`Workspace: ${homeAlias}\\project`)).toBe("Workspace: ~\\project");
        expect(displayString(`İ Workspace: ${homeAlias}\\project`)).toBe("İ Workspace: ~\\project");
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    },
  );
});
