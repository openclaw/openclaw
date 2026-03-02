/**
 * Vitest benchmarks for code-mode plugin hot paths.
 *
 * Measures the real-world performance-critical paths:
 * - vm.createContext + sandbox execution overhead
 * - API declaration / context generation
 * - Path security (resolveSecurePath) via file I/O
 * - Output truncation via large sandbox outputs
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, bench, describe } from "vitest";
import { buildCodeModeContext, generateApiDeclarations } from "./api-generator.js";
import { executeSandboxCode } from "./sandbox.js";

// ---------------------------------------------------------------------------
// Shared temp directory for all benchmarks
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "code-mode-bench-"));
  // Pre-create files used by read benchmarks
  await fs.writeFile(path.join(tmpDir, "small.txt"), "hello world", "utf8");
  await fs.writeFile(path.join(tmpDir, "medium.txt"), "x".repeat(4096), "utf8");
  // ~512 KB file to exercise truncateString (MAX_OUTPUT_BYTES is 256 KB)
  await fs.writeFile(path.join(tmpDir, "large.txt"), "L".repeat(512 * 1024), "utf8");
});

afterAll(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 1. Sandbox execution overhead
// ---------------------------------------------------------------------------

describe("sandbox execution overhead", () => {
  bench("simple expression: return 1 + 1", async () => {
    await executeSandboxCode("return 1 + 1", { workspaceDir: tmpDir });
  });

  bench("console.log calls (5 lines)", async () => {
    await executeSandboxCode(
      `
      console.log("line 1");
      console.log("line 2");
      console.log("line 3");
      console.log("line 4");
      console.log("line 5");
      return "done";
      `,
      { workspaceDir: tmpDir },
    );
  });

  bench("api.readFile (small file, includes resolveSecurePath + realpath)", async () => {
    await executeSandboxCode('return await api.readFile("small.txt")', { workspaceDir: tmpDir });
  });

  bench("vm.createContext cost baseline (no-op code)", async () => {
    // This measures the dominant per-invocation cost: context creation,
    // script compilation, and IIFE wrapping with no actual work.
    await executeSandboxCode("", { workspaceDir: tmpDir });
  });
});

// ---------------------------------------------------------------------------
// 2. API declaration generation
// ---------------------------------------------------------------------------

describe("API declaration generation", () => {
  bench("generateApiDeclarations (network enabled)", () => {
    generateApiDeclarations({ allowNetwork: true });
  });

  bench("generateApiDeclarations (network disabled)", () => {
    generateApiDeclarations({ allowNetwork: false });
  });

  bench("buildCodeModeContext (network enabled)", () => {
    buildCodeModeContext({ allowNetwork: true });
  });

  bench("buildCodeModeContext (network disabled)", () => {
    buildCodeModeContext({ allowNetwork: false });
  });
});

// ---------------------------------------------------------------------------
// 3. Path security via file I/O (resolveSecurePath overhead)
// ---------------------------------------------------------------------------

describe("path security via file I/O", () => {
  bench("readFile — workspace-root file", async () => {
    await executeSandboxCode('return await api.readFile("small.txt")', { workspaceDir: tmpDir });
  });

  bench("writeFile — create + overwrite in workspace root", async () => {
    await executeSandboxCode('await api.writeFile("bench-write.txt", "bench data"); return "ok"', {
      workspaceDir: tmpDir,
    });
  });

  bench("writeFile — nested subdirectory (mkdir -p)", async () => {
    await executeSandboxCode(
      'await api.writeFile("bench-sub/deep/file.txt", "nested"); return "ok"',
      { workspaceDir: tmpDir },
    );
  });

  bench("readFile + writeFile round-trip", async () => {
    await executeSandboxCode(
      `
      const data = await api.readFile("small.txt");
      await api.writeFile("bench-roundtrip.txt", data.toUpperCase());
      return data.length;
      `,
      { workspaceDir: tmpDir },
    );
  });
});

// ---------------------------------------------------------------------------
// 4. truncateString — exercised through sandbox with large outputs
// ---------------------------------------------------------------------------

describe("truncateString via large sandbox output", () => {
  bench("readFile — 4 KB file (no truncation)", async () => {
    await executeSandboxCode('return await api.readFile("medium.txt")', { workspaceDir: tmpDir });
  });

  bench("readFile — 512 KB file (triggers truncation at 256 KB)", async () => {
    await executeSandboxCode('return await api.readFile("large.txt")', { workspaceDir: tmpDir });
  });

  bench("console.log large string (256 KB+)", async () => {
    // Generate a large string inside the sandbox and log it.
    // truncateString is not applied to logs directly, but this measures
    // the log accumulation cost with large payloads.
    await executeSandboxCode(
      `
      const big = "Z".repeat(300 * 1024);
      console.log(big);
      return big.length;
      `,
      { workspaceDir: tmpDir },
    );
  });
});
