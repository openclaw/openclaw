import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildM365DelegatedCredentials,
  createM365CredentialStore,
  resolveM365IdentityCredentialsPath,
  sanitizeM365IdentityId,
} from "./credentials.js";

describe("m365 credential store", () => {
  let tempDir: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-m365-credentials-"));
    env = { OPENCLAW_STATE_DIR: tempDir } as NodeJS.ProcessEnv;
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("sanitizes identity ids for credential file names", () => {
    expect(sanitizeM365IdentityId(" User:Ops/Delegate ")).toBe("user_ops_delegate");
    expect(resolveM365IdentityCredentialsPath({ identityId: "Ops", env })).toBe(
      path.join(tempDir, "credentials", "m365", "identity-ops.json"),
    );
  });

  it("saves and loads delegated credentials keyed by identity id", async () => {
    const store = createM365CredentialStore({ env });
    const credentials = buildM365DelegatedCredentials({
      identityId: "ops",
      tenantId: "tenant",
      clientId: "client",
      accessToken: "access-token",
      refreshToken: "refresh-token",
      expiresAt: 12345,
      now: new Date("2026-01-01T00:00:00.000Z"),
    });

    await store.save(credentials);

    expect(await store.load("ops")).toEqual(credentials);
    expect(await fs.readFile(store.pathForIdentity("ops"), "utf-8")).toContain("access-token");
  });
});
