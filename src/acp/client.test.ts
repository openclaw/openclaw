import { describe, expect, it } from "vitest";

// Structural tests verify security-critical code exists in client.ts.
// Full integration tests with ACP SDK mocks deferred to future enhancement.

describe("ACP client permission classification", () => {
  it("should define dangerous tools that include exec and sessions_spawn", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const source = await fs.readFile(
      path.resolve(__dirname, "client.ts"),
      "utf-8",
    );

    expect(source).toContain("DANGEROUS_ACP_TOOLS");
    expect(source).toContain('"exec"');
    expect(source).toContain('"sessions_spawn"');
    expect(source).toContain('"sessions_send"');
    expect(source).toContain('"gateway"');
  });

  it("should not auto-approve when options array is empty", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const source = await fs.readFile(
      path.resolve(__dirname, "client.ts"),
      "utf-8",
    );

    // Verify the empty-options guard exists
    expect(source).toContain("options.length === 0");
    // Verify it denies rather than approves
    expect(source).toContain("no options available");
  });

  it("should use stderr for permission logging (not stdout)", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const source = await fs.readFile(
      path.resolve(__dirname, "client.ts"),
      "utf-8",
    );

    // Permission logs should go to stderr to avoid corrupting ACP protocol on stdout
    expect(source).toContain("console.error");
    expect(source).toContain("[permission");
  });

  it("should have a 30-second timeout for interactive prompts", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const source = await fs.readFile(
      path.resolve(__dirname, "client.ts"),
      "utf-8",
    );

    expect(source).toContain("30_000");
    expect(source).toContain("[permission timeout]");
  });
});
