import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  APP_PROFILE_CONTEXT_NAME,
  APP_PROFILE_MAX_BYTES,
  appendAppProfileBootstrapFile,
  appUserIdFromSessionKey,
  buildAppProfileContextFile,
  clampAppProfile,
  extractAppProfileSection,
} from "./app-profile-context.ts";

const wrap = (inner: string) =>
  `# user\n\n<!-- app:app_profile:start -->\n${inner}\n<!-- app:app_profile:end -->\n`;

describe("extractAppProfileSection", () => {
  it("extracts and trims the inner section body", () => {
    expect(extractAppProfileSection(wrap("name: Dana\nsummary: |\n  hi"))).toBe(
      "name: Dana\nsummary: |\n  hi",
    );
  });

  it("returns null when the section is absent", () => {
    expect(extractAppProfileSection("# user\nno markers here")).toBeNull();
  });

  it("returns null on a start without an end (malformed)", () => {
    expect(extractAppProfileSection("<!-- app:app_profile:start -->\nname: Dana")).toBeNull();
  });

  it("returns null on duplicate markers (ambiguous, fail closed)", () => {
    const dup = wrap("name: Alice") + wrap("name: Bob");
    expect(extractAppProfileSection(dup)).toBeNull();
  });

  it("returns null on an empty/whitespace-only body", () => {
    expect(extractAppProfileSection(wrap("   "))).toBeNull();
  });

  it("ignores other app sections", () => {
    const file =
      "<!-- app:User_D_Prompt:start -->\nq1\n<!-- app:User_D_Prompt:end -->\n\n" +
      wrap("name: Dana");
    expect(extractAppProfileSection(file)).toBe("name: Dana");
  });
});

describe("clampAppProfile", () => {
  it("leaves content within the cap unchanged", () => {
    expect(clampAppProfile("name: Dana")).toBe("name: Dana");
  });

  it("bounds oversize content to the byte cap", () => {
    const big = "x".repeat(APP_PROFILE_MAX_BYTES + 500);
    const clamped = clampAppProfile(big);
    expect(Buffer.byteLength(clamped, "utf8")).toBeLessThanOrEqual(APP_PROFILE_MAX_BYTES);
    expect(clamped.length).toBeLessThan(big.length);
  });

  it("truncates on a UTF-8 boundary without leaving a replacement char", () => {
    // 3-byte chars: 2048 is not a multiple of 3, so the cut straddles a char and
    // the truncated trailing byte sequence must be dropped (no U+FFFD tail).
    const s = "你".repeat(1000); // 3000 bytes → over the cap, straddles at 2048
    const clamped = clampAppProfile(s);
    expect(Buffer.byteLength(clamped, "utf8")).toBeLessThanOrEqual(APP_PROFILE_MAX_BYTES);
    expect(clamped.endsWith("�")).toBe(false);
  });
});

describe("buildAppProfileContextFile", () => {
  it("builds a synthetic APP_PROFILE.md file from a profile section", () => {
    const f = buildAppProfileContextFile(wrap("name: Dana"));
    expect(f).not.toBeNull();
    expect(f?.name).toBe(APP_PROFILE_CONTEXT_NAME);
    expect(f?.path).toBe(APP_PROFILE_CONTEXT_NAME); // bare filename, no users/<id> leak
    expect(f?.content).toBe("name: Dana");
    expect(f?.missing).toBe(false);
  });

  it("returns null when there is no profile section", () => {
    expect(buildAppProfileContextFile("# user\nnothing")).toBeNull();
  });

  it("clamps an oversize profile body", () => {
    const f = buildAppProfileContextFile(wrap("x".repeat(APP_PROFILE_MAX_BYTES + 100)));
    expect(Buffer.byteLength(f?.content ?? "", "utf8")).toBeLessThanOrEqual(APP_PROFILE_MAX_BYTES);
  });
});

describe("appendAppProfileBootstrapFile", () => {
  const base = [
    { name: "AGENTS.md", path: "/w/AGENTS.md", content: "a", missing: false },
  ] as never[];

  it("is a no-op for a non-app session (returns the files unchanged)", async () => {
    const out = await appendAppProfileBootstrapFile(base, {
      workspaceDir: "/w",
      sessionKey: "agent:main:telegram:acct:direct:123",
    });
    expect(out).toBe(base);
  });

  it("is a no-op when there is no session key", async () => {
    const out = await appendAppProfileBootstrapFile(base, { workspaceDir: "/w" });
    expect(out).toBe(base);
  });

  it("injects via the sessionKey fallback when the entry has no appUserId (first turn)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "app-profile-ctx-"));
    try {
      await mkdir(join(dir, "users"), { recursive: true });
      await writeFile(join(dir, "users", "user_xyz.md"), wrap("name: Dana"), "utf-8");
      const out = await appendAppProfileBootstrapFile(base, {
        workspaceDir: dir,
        sessionKey: "agent:main:app:havaya:user_xyz:2db59c18-3029-4165-83fb-a4c94d4df05f",
      });
      expect(out.length).toBe(base.length + 1);
      expect(out[out.length - 1]?.name).toBe(APP_PROFILE_CONTEXT_NAME);
      expect(out[out.length - 1]?.content).toBe("name: Dana");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("appUserIdFromSessionKey", () => {
  it("extracts the userId from a namespaced 4-part app key", () => {
    expect(
      appUserIdFromSessionKey(
        "agent:main:app:havaya:user_abc123:550e8400-e29b-41d4-a716-446655440000",
      ),
    ).toBe("user_abc123");
  });

  it("extracts the userId from a legacy 3-part app key (no namespace)", () => {
    expect(appUserIdFromSessionKey("agent:main:app:user_abc123:conv-1")).toBe("user_abc123");
  });

  it("works on a bare app: key with no agent prefix", () => {
    expect(appUserIdFromSessionKey("app:havaya:user_abc:conv-1")).toBe("user_abc");
  });

  it("lowercases the extracted id to match the on-disk filename", () => {
    expect(appUserIdFromSessionKey("agent:main:app:havaya:User_ABC:conv-1")).toBe("user_abc");
  });

  it("returns null for a non-app session key", () => {
    expect(appUserIdFromSessionKey("agent:main:telegram:acct:direct:123")).toBeNull();
  });

  it("returns null when there is no userId segment", () => {
    expect(appUserIdFromSessionKey("agent:main:app:havaya")).toBeNull();
  });

  it("returns null for undefined", () => {
    expect(appUserIdFromSessionKey(undefined)).toBeNull();
  });
});
