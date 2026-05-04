import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runtimeState = vi.hoisted(() => ({
  config: {} as {
    session?: { scope?: "global"; mainKey?: string; store?: string };
    agents?: { list?: Array<{ id?: string; default?: boolean }> };
  },
}));

vi.mock("../config/io.js", () => ({
  getRuntimeConfig: () => runtimeState.config,
}));

import {
  evaluateSessionRuntimeEnvelope,
  readSessionRuntimeEnvelope,
} from "./session-runtime-envelope.js";

const tempDirs: string[] = [];

function createSessionStore(contents: string): string {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-session-envelope-"));
  tempDirs.push(tempDir);
  const storePath = path.join(tempDir, "sessions.json");
  fs.writeFileSync(storePath, contents);
  runtimeState.config = { session: { store: storePath } };
  return storePath;
}

describe("session runtime envelope", () => {
  beforeEach(() => {
    runtimeState.config = {};
  });

  afterEach(() => {
    for (const tempDir of tempDirs.splice(0)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("reads envelopes from the session store", () => {
    createSessionStore(
      JSON.stringify({
        "agent:main:main": { envelope: { allowedTools: ["Read"] } },
      }),
    );

    expect(readSessionRuntimeEnvelope("agent:main:main")).toEqual({
      ok: true,
      envelope: { allowedTools: ["Read"] },
    });
  });

  it("uses the freshest matching session entry when reading envelopes", () => {
    createSessionStore(
      JSON.stringify({
        "agent:main:work": {
          updatedAt: 100,
          envelope: { allowedTools: ["Read"] },
        },
        "agent:main:WORK": {
          updatedAt: 200,
        },
        "agent:main:demo": {
          updatedAt: 100,
          envelope: { allowedTools: ["Read"] },
        },
        "agent:main:DEMO": {
          updatedAt: 200,
          envelope: { disallowedTools: ["Bash"] },
        },
      }),
    );

    expect(readSessionRuntimeEnvelope("agent:main:work")).toEqual({ ok: true });
    expect(readSessionRuntimeEnvelope("agent:main:demo")).toEqual({
      ok: true,
      envelope: { disallowedTools: ["Bash"] },
    });
  });

  it("reads global envelopes from the configured default agent store", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-session-envelope-global-"));
    tempDirs.push(tempDir);
    const storeTemplate = path.join(tempDir, "{agentId}", "sessions.json");
    const opsStorePath = path.join(tempDir, "ops", "sessions.json");
    const mainStorePath = path.join(tempDir, "main", "sessions.json");
    fs.mkdirSync(path.dirname(opsStorePath), { recursive: true });
    fs.mkdirSync(path.dirname(mainStorePath), { recursive: true });
    fs.writeFileSync(
      opsStorePath,
      JSON.stringify({
        global: { envelope: { allowedTools: ["Read"] } },
      }),
    );
    fs.writeFileSync(mainStorePath, JSON.stringify({ global: {} }));
    runtimeState.config = {
      session: { scope: "global", store: storeTemplate },
      agents: { list: [{ id: "ops", default: true }, { id: "main" }] },
    };

    expect(readSessionRuntimeEnvelope("global")).toEqual({
      ok: true,
      envelope: { allowedTools: ["Read"] },
    });
  });

  it("fails closed when the session store cannot be parsed", () => {
    createSessionStore("{");

    expect(readSessionRuntimeEnvelope("agent:main:main")).toMatchObject({
      ok: false,
      reason: expect.stringContaining("failed to parse session store"),
    });
  });

  it("treats a missing session store as no envelope", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-session-envelope-missing-"));
    tempDirs.push(tempDir);
    runtimeState.config = { session: { store: path.join(tempDir, "missing-sessions.json") } };

    expect(readSessionRuntimeEnvelope("agent:main:main")).toEqual({ ok: true });
  });

  it("blocks tools outside allowedTools", () => {
    expect(
      evaluateSessionRuntimeEnvelope({
        envelope: { allowedTools: ["Read"] },
        toolName: "Bash",
        toolParams: {},
      }),
    ).toMatchObject({ allowed: false });
  });

  it("blocks denied paths and paths outside allowedPaths", () => {
    expect(
      evaluateSessionRuntimeEnvelope({
        envelope: { deniedPaths: ["/repo/secrets/**"] },
        toolName: "Read",
        toolParams: { path: "/repo/secrets/token.txt" },
      }),
    ).toMatchObject({ allowed: false });

    expect(
      evaluateSessionRuntimeEnvelope({
        envelope: { allowedPaths: ["/repo/src/**"] },
        toolName: "Write",
        toolParams: { filePath: "/repo/src/index.ts" },
      }),
    ).toEqual({ allowed: true });

    expect(
      evaluateSessionRuntimeEnvelope({
        envelope: { allowedPaths: ["/repo/src/**"] },
        toolName: "Write",
        toolParams: { filePath: "/repo/src/../package.json" },
      }),
    ).toMatchObject({ allowed: false });
  });

  it("canonicalizes paths before matching envelope globs", () => {
    expect(
      evaluateSessionRuntimeEnvelope({
        envelope: { deniedPaths: ["/repo/secrets/**"] },
        toolName: "Read",
        toolParams: { path: "/repo/src/../secrets/token.txt" },
      }),
    ).toMatchObject({
      allowed: false,
      reason: "Path blocked by session envelope: /repo/secrets/token.txt",
    });

    expect(
      evaluateSessionRuntimeEnvelope({
        envelope: { allowedPaths: ["/repo/src/**"] },
        toolName: "Read",
        toolParams: { path: "/repo/src/../secrets/token.txt" },
      }),
    ).toMatchObject({
      allowed: false,
      reason: "Path outside session envelope: /repo/secrets/token.txt",
    });
  });

  it("resolves relative tool paths against the active workspace before envelope matching", () => {
    expect(
      evaluateSessionRuntimeEnvelope({
        envelope: { deniedPaths: ["/repo/secrets/**"] },
        toolName: "Read",
        toolParams: { path: "secrets/token.txt" },
        workspaceDir: "/repo",
      }),
    ).toMatchObject({
      allowed: false,
      reason: "Path blocked by session envelope: /repo/secrets/token.txt",
    });

    expect(
      evaluateSessionRuntimeEnvelope({
        envelope: { allowedPaths: ["/repo/src/**"] },
        toolName: "Write",
        toolParams: { path: "src/index.ts" },
        workspaceDir: "/repo",
      }),
    ).toEqual({ allowed: true });

    expect(
      evaluateSessionRuntimeEnvelope({
        envelope: { allowedPaths: ["/repo/src/**"] },
        toolName: "Write",
        toolParams: { path: "secrets/token.txt" },
        workspaceDir: "/repo",
      }),
    ).toMatchObject({
      allowed: false,
      reason: "Path outside session envelope: /repo/secrets/token.txt",
    });
  });

  it("expands home-relative tool paths before envelope matching", () => {
    const originalHome = process.env.HOME;
    const originalUserProfile = process.env.USERPROFILE;
    process.env.HOME = "/home/openclaw-test";
    delete process.env.USERPROFILE;
    try {
      expect(
        evaluateSessionRuntimeEnvelope({
          envelope: { deniedPaths: ["/home/openclaw-test/secrets/**"] },
          toolName: "Read",
          toolParams: { path: "~/secrets/token.txt" },
          workspaceDir: "/repo",
        }),
      ).toMatchObject({
        allowed: false,
        reason: "Path blocked by session envelope: /home/openclaw-test/secrets/token.txt",
      });
    } finally {
      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }
      if (originalUserProfile === undefined) {
        delete process.env.USERPROFILE;
      } else {
        process.env.USERPROFILE = originalUserProfile;
      }
    }
  });

  it("maps sandbox container workspace paths onto the active workspace for matching", () => {
    expect(
      evaluateSessionRuntimeEnvelope({
        envelope: { deniedPaths: ["/repo/secrets/**"] },
        toolName: "Read",
        toolParams: { path: "/workspace/secrets/token.txt" },
        workspaceDir: "/repo",
        containerWorkdir: "/workspace",
      }),
    ).toMatchObject({
      allowed: false,
      reason: "Path blocked by session envelope: /repo/secrets/token.txt",
    });
  });

  it("canonicalizes local file URLs before envelope matching", () => {
    expect(
      evaluateSessionRuntimeEnvelope({
        envelope: { deniedPaths: ["/repo/secrets/**"] },
        toolName: "Read",
        toolParams: { path: "file:///repo/secrets/token.txt" },
        workspaceDir: "/repo",
      }),
    ).toMatchObject({
      allowed: false,
      reason: "Path blocked by session envelope: /repo/secrets/token.txt",
    });
  });

  it("enforces bash command allowlists", () => {
    expect(
      evaluateSessionRuntimeEnvelope({
        envelope: { bashCommandAllowlist: ["pnpm test"] },
        toolName: "Bash",
        toolParams: { command: "pnpm test src/agents/session-runtime-envelope.test.ts" },
      }),
    ).toEqual({ allowed: true });

    expect(
      evaluateSessionRuntimeEnvelope({
        envelope: { bashCommandAllowlist: ["pnpm test"] },
        toolName: "Bash",
        toolParams: { command: "curl https://example.com" },
      }),
    ).toMatchObject({ allowed: false });

    expect(
      evaluateSessionRuntimeEnvelope({
        envelope: { bashCommandAllowlist: ["pnpm test"] },
        toolName: "Bash",
        toolParams: { command: "curl https://example.com && pnpm test" },
      }),
    ).toMatchObject({ allowed: false });

    expect(
      evaluateSessionRuntimeEnvelope({
        envelope: { bashCommandAllowlist: ["pnpm test"] },
        toolName: "Bash",
        toolParams: { command: "pnpm test && curl https://example.com" },
      }),
    ).toMatchObject({ allowed: false });

    expect(
      evaluateSessionRuntimeEnvelope({
        envelope: { bashCommandAllowlist: ["pnpm test"] },
        toolName: "Bash",
        toolParams: { command: "pnpm test & curl https://example.com" },
      }),
    ).toMatchObject({ allowed: false });
  });

  it("requires regex command allowlists to match the whole command", () => {
    expect(
      evaluateSessionRuntimeEnvelope({
        envelope: { bashCommandAllowlist: ["/^pnpm test(?:\\s+[\\w./-]+)?$/"] },
        toolName: "Bash",
        toolParams: { command: "pnpm test src/agents/session-runtime-envelope.test.ts" },
      }),
    ).toEqual({ allowed: true });

    expect(
      evaluateSessionRuntimeEnvelope({
        envelope: { bashCommandAllowlist: ["/pnpm test/"] },
        toolName: "Bash",
        toolParams: { command: "curl https://example.com && pnpm test" },
      }),
    ).toMatchObject({ allowed: false });
  });

  it("does not expose network policy as hook-level enforcement", () => {
    expect(
      evaluateSessionRuntimeEnvelope({
        envelope: { allowedTools: ["fetch"] },
        toolName: "fetch",
        toolParams: { query: "example.com" },
      }),
    ).toEqual({ allowed: true });
  });
});
