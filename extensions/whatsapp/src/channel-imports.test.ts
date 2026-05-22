import { describe, expect, it } from "vitest";

describe("whatsapp channel registration imports", () => {
  it("defers heartbeat readiness runtime out of the channel descriptor", async () => {
    const source = await import("node:fs/promises").then((fs) =>
      fs.readFile(new URL("./channel.ts", import.meta.url), "utf8"),
    );

    expect(source).not.toContain('from "./heartbeat.js"');
    expect(source).toContain('import("./heartbeat.js")');
  });

  it("defers doctor-only security repair code out of the shared descriptor", async () => {
    const source = await import("node:fs/promises").then((fs) =>
      fs.readFile(new URL("./shared.ts", import.meta.url), "utf8"),
    );

    expect(source).not.toContain('from "./security-fix.js"');
    expect(source).toContain('import("./security-fix.js")');
  });
});
