import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createNexusServer } from "../interfaces/nexus/server.js";
import { installPackFromNexus } from "./nexus-client.js";

describe("nexus client install", () => {
  let server: Server | null = null;
  let port = 0;

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
    }
  });

  it("downloads and extracts pack from registry", async () => {
    const catalog = await mkdtemp(join(tmpdir(), "nexus-cli-"));
    const packDir = join(catalog, "remote-pack");
    await mkdir(join(packDir, "ontology"), { recursive: true });
    await writeFile(
      join(packDir, "claworks.pack.json"),
      JSON.stringify({
        id: "remote-pack",
        name: "Remote",
        version: "2.0.0",
        license: "MIT",
        provides: { objectTypes: [], playbooks: [], actionTypes: [] },
      }),
      "utf8",
    );

    const nexus = await createNexusServer(catalog);
    server = await nexus.listen(0, "127.0.0.1");
    const addr = server.address();
    port = typeof addr === "object" && addr ? addr.port : 0;

    const installRoot = await mkdtemp(join(tmpdir(), "packs-install-"));
    const result = await installPackFromNexus({
      registry: `http://127.0.0.1:${port}`,
      source: "nexus://remote-pack@2.0.0",
      installRoot,
    });

    expect(result.slug).toBe("remote-pack");
    expect(result.version).toBe("2.0.0");
    const manifest = JSON.parse(
      await readFile(join(result.path, "claworks.pack.json"), "utf8"),
    ) as { id: string };
    expect(manifest.id).toBe("remote-pack");
  });
});
