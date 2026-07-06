import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DATA_READ_RPC_ALLOWLIST, resolveBinding } from "./data-read.js";

async function withTempStateDir<T>(run: (stateDir: string) => Promise<T>): Promise<T> {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-dashboard-data-"));
  try {
    return await run(stateDir);
  } finally {
    await fs.rm(stateDir, { recursive: true, force: true });
  }
}

describe("dashboard data binding resolver", () => {
  it("returns static values", async () => {
    await expect(resolveBinding({ source: "static", value: { ok: true } })).resolves.toEqual({
      ok: true,
    });
  });

  it("returns the client-resolution signal for rpc bindings", async () => {
    expect(DATA_READ_RPC_ALLOWLIST).toContain("sessions.list");

    await expect(resolveBinding({ source: "rpc", method: "sessions.list" })).rejects.toMatchObject({
      code: "binding_client_resolved",
    });
  });

  it("allowlists the read methods the L4 builtin data widgets bind", () => {
    // Frozen so a builtin can never reference a method the write-time schema
    // would reject. system-presence backs builtin:instances; cron.runs backs
    // builtin:activity; usage.cost backs the stat-cards + usage widget.
    for (const method of [
      "usage.cost",
      "sessions.list",
      "cron.list",
      "cron.runs",
      "system-presence",
    ]) {
      expect(DATA_READ_RPC_ALLOWLIST).toContain(method);
    }
  });

  it("reads JSON pointers and raw markdown from the dashboard data jail", async () => {
    await withTempStateDir(async (stateDir) => {
      await fs.mkdir(path.join(stateDir, "dashboard", "data", "metrics"), { recursive: true });
      await fs.writeFile(
        path.join(stateDir, "dashboard", "data", "metrics", "q3.json"),
        JSON.stringify({ revenue: 42, nested: { "a/b": "escaped" } }),
      );
      await fs.writeFile(path.join(stateDir, "dashboard", "data", "notes.md"), "# Notes\n");

      await expect(
        resolveBinding(
          { source: "file", path: "metrics/q3.json", pointer: "/nested/a~1b" },
          { stateDir },
        ),
      ).resolves.toBe("escaped");
      await expect(
        resolveBinding({ source: "file", path: "notes.md" }, { stateDir }),
      ).resolves.toBe("# Notes\n");
    });
  });

  it("rejects file traversal and oversized files with typed errors", async () => {
    await withTempStateDir(async (stateDir) => {
      await expect(
        resolveBinding({ source: "file", path: "../secrets.json" }, { stateDir }),
      ).rejects.toMatchObject({ code: "binding_invalid" });

      await fs.mkdir(path.join(stateDir, "dashboard", "data"), { recursive: true });
      await fs.writeFile(
        path.join(stateDir, "dashboard", "data", "big.csv"),
        "x".repeat(1_100_000),
      );

      await expect(
        resolveBinding({ source: "file", path: "big.csv" }, { stateDir }),
      ).rejects.toMatchObject({ code: "binding_too_large" });
    });
  });
});
