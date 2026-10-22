import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseBuzzQaCredentialPayload, readBuzzQaCredentialFile } from "./credentials.js";

const credentialPayload = {
  relayUrl: "wss://relay.qa.example",
  roomId: "123e4567-e89b-42d3-a456-426614174000",
  driverPrivateKey: "01".repeat(32),
  sutPrivateKey: "02".repeat(32),
};
const tempDirs: string[] = [];

afterEach(() =>
  Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { force: true, recursive: true }))),
);

async function writeCredentials(contents: string, filePath = "buzz.json") {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-buzz-qa-"));
  tempDirs.push(repoRoot);
  await fs.mkdir(path.dirname(path.join(repoRoot, filePath)), { recursive: true });
  await fs.writeFile(path.join(repoRoot, filePath), contents, { mode: 0o600 });
  return { filePath, repoRoot };
}

describe("Buzz QA credentials", () => {
  it("accepts a strict two-identity room payload", () => {
    const credentials = parseBuzzQaCredentialPayload({
      ...credentialPayload,
      driverAuthTag: '["auth","driver","conditions","signature"]',
      sutAuthTag: '["auth","sut","conditions","signature"]',
    });

    expect(credentials).toMatchObject(credentialPayload);
    expect(credentials.driverPublicKey).toMatch(/^[a-f0-9]{64}$/u);
    expect(credentials.sutPublicKey).toMatch(/^[a-f0-9]{64}$/u);
    expect(credentials.driverPublicKey).not.toBe(credentials.sutPublicKey);
  });

  it("allows plaintext loopback relay URLs", () => {
    const relayUrl = "ws://127.0.0.1:8080";
    expect(parseBuzzQaCredentialPayload({ ...credentialPayload, relayUrl }).relayUrl).toBe(
      relayUrl,
    );
  });

  it("rejects plaintext remote relay URLs", () => {
    expect(() =>
      parseBuzzQaCredentialPayload({ ...credentialPayload, relayUrl: "ws://relay.qa.example" }),
    ).toThrow("Buzz QA credentials are missing or malformed.");
  });

  it("never includes credential values in validation errors", () => {
    const invalid = { driverPrivateKey: "bad-key", driverAuthTag: "bad-tag" };
    try {
      parseBuzzQaCredentialPayload({ ...credentialPayload, ...invalid });
      expect.fail("Expected malformed credentials to be rejected");
    } catch (error) {
      expect(error).toMatchObject({ message: "Buzz QA credentials are missing or malformed." });
      expect(String(error)).not.toContain(invalid.driverPrivateKey);
      expect(String(error)).not.toContain(invalid.driverAuthTag);
    }
  });

  it("reads a repo-relative private JSON credential file", async () => {
    const file = await writeCredentials(JSON.stringify(credentialPayload), "private/buzz.json");
    await expect(readBuzzQaCredentialFile(file)).resolves.toMatchObject(credentialPayload);
  });

  it("does not echo malformed file contents", async () => {
    const secret = "private-key-material-must-not-leak";
    const file = await writeCredentials(`{${secret}`);
    const error = await readBuzzQaCredentialFile(file).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toContain("is not valid JSON");
    expect(String(error)).not.toContain(secret);
    expect(error).not.toHaveProperty("cause");
  });
});
