import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

it("pins the reviewed bundled catalog discovery proxy (live metadata may drift)", () => {
  // Synthetic identities avoid shipping model names; flags were projected from
  // the exact public source identified by commit/path/hash in the fixture.
  const bytes = readFileSync(new URL("./tool-discovery.catalog.fixture.json", import.meta.url));
  const catalog = JSON.parse(bytes.toString()) as {
    codexVersion: string;
    commit: string;
    sourceSha256: string;
    models: { identitySha256: string; supportsSearchTool: boolean; codeModeOnly: boolean }[];
  };
  // Git may convert fixture line endings; pin content, not checkout bytes.
  for (const newline of ["\n", "\r\n"]) {
    const content = JSON.parse(bytes.toString().replace(/\r?\n/g, newline));
    expect(createHash("sha256").update(JSON.stringify(content)).digest("hex")).toBe(
      "45c9a84574231dd3c026673b21f56dd9e95a2e1376838cc6d4ce837d3fceecaf",
    );
  }
  expect(catalog.codexVersion).toBe("0.164.0");
  expect(catalog.commit).toBe("6aaac694803004a63c6f393d153c96d22521a6b9");
  expect(catalog.sourceSha256).toBe(
    "943ca7fe1d19ed019054158303f0dbbd80b3bef43b3aa425a71aa7cb3fb52c2b",
  );
  expect(catalog.models).toHaveLength(11);
  expect(new Set(catalog.models.map((model) => model.identitySha256)).size).toBe(
    catalog.models.length,
  );
  expect(catalog.models.every((model) => model.supportsSearchTool || model.codeModeOnly)).toBe(
    true,
  );
  // Membership alone does not imply Code Mode; prompt guidance must be conditional.
  expect(catalog.models.some((model) => model.supportsSearchTool && !model.codeModeOnly)).toBe(
    true,
  );
});
