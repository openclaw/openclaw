import { mkdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTrackedTempDirs } from "../test-utils/tracked-temp-dirs.js";
import { MAX_SECRET_FILE_BYTES, readSecretFromFile } from "./secret-file.js";

const tempDirs = createTrackedTempDirs();
const createTempDir = () => tempDirs.make("openclaw-secret-file-test-");

afterEach(async () => {
  await tempDirs.cleanup();
});

describe("readSecretFromFile", () => {
  it("reads and trims a regular secret file", async () => {
    const dir = await createTempDir();
    const file = path.join(dir, "secret.txt");
    await writeFile(file, " top-secret \n", "utf8");

    expect(readSecretFromFile(file, "Gateway password")).toBe("top-secret");
  });

  it("rejects files larger than the secret-file limit", async () => {
    const dir = await createTempDir();
    const file = path.join(dir, "secret.txt");
    await writeFile(file, "x".repeat(MAX_SECRET_FILE_BYTES + 1), "utf8");

    expect(() => readSecretFromFile(file, "Gateway password")).toThrow(
      `Gateway password file at ${file} exceeds ${MAX_SECRET_FILE_BYTES} bytes.`,
    );
  });

  it("rejects non-regular files", async () => {
    const dir = await createTempDir();
    const nestedDir = path.join(dir, "secret-dir");
    await mkdir(nestedDir);

    expect(() => readSecretFromFile(nestedDir, "Gateway password")).toThrow(
      `Gateway password file at ${nestedDir} must be a regular file.`,
    );
  });

  it("rejects symlinks", async () => {
    const dir = await createTempDir();
    const target = path.join(dir, "target.txt");
    const link = path.join(dir, "secret-link.txt");
    await writeFile(target, "top-secret\n", "utf8");
    await symlink(target, link);

    expect(() => readSecretFromFile(link, "Gateway password")).toThrow(
      `Gateway password file at ${link} must not be a symlink.`,
    );
  });
});
