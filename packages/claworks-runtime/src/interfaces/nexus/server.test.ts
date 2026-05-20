import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createNexusServer } from "./server.js";

describe("nexus server", () => {
  let server: Server | null = null;
  let port = 0;

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = null;
    }
  });

  it("lists and serves pack artifacts", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nexus-srv-"));
    const packDir = join(dir, "tiny");
    await mkdir(join(packDir, "ontology"), { recursive: true });
    await writeFile(
      join(packDir, "claworks.pack.json"),
      JSON.stringify({
        id: "tiny",
        name: "Tiny Pack",
        version: "0.1.0",
        license: "MIT",
        provides: { objectTypes: [], playbooks: [], actionTypes: [] },
      }),
      "utf8",
    );

    const nexus = await createNexusServer(dir);
    server = await nexus.listen(0, "127.0.0.1");
    const addr = server.address();
    port = typeof addr === "object" && addr ? addr.port : 0;

    const listRes = await fetch(`http://127.0.0.1:${port}/api/packages?family=claworks-pack`);
    const listBody = (await listRes.json()) as { packages: Array<{ slug: string }> };
    expect(listBody.packages.some((p) => p.slug === "tiny")).toBe(true);

    const artRes = await fetch(
      `http://127.0.0.1:${port}/api/packages/tiny/versions/0.1.0/artifacts/generic`,
    );
    expect(artRes.ok).toBe(true);
    const buf = Buffer.from(await artRes.arrayBuffer());
    expect(buf.length).toBeGreaterThan(10);
  });
});
