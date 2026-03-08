import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withEnvAsync } from "../test-utils/env.js";
import { collectProviderApiKeys } from "./live-auth-keys.js";

describe("collectProviderApiKeys", () => {
  it("reads OPENAI_API_KEY_FILE when OPENAI_API_KEY is unset", async () => {
    await withEnvAsync(
      {
        OPENAI_API_KEY: undefined,
        OPENAI_API_KEY_FILE: undefined,
      },
      async () => {
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-live-keys-"));
        const file = path.join(dir, "openai.txt");
        await fs.writeFile(file, "sk-file-openai-key\n", "utf8");

        try {
          process.env.OPENAI_API_KEY_FILE = file;
          expect(collectProviderApiKeys("openai")).toEqual(["sk-file-openai-key"]);
        } finally {
          await fs.rm(dir, { recursive: true, force: true });
        }
      },
    );
  });

  it("prefers OPENAI_API_KEY over OPENAI_API_KEY_FILE", async () => {
    await withEnvAsync(
      {
        OPENAI_API_KEY: undefined,
        OPENAI_API_KEY_FILE: undefined,
      },
      async () => {
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-live-keys-"));
        const file = path.join(dir, "openai.txt");
        await fs.writeFile(file, "sk-file-openai-key\n", "utf8");

        try {
          process.env.OPENAI_API_KEY = "sk-direct-openai-key";
          process.env.OPENAI_API_KEY_FILE = file;
          expect(collectProviderApiKeys("openai")).toEqual(["sk-direct-openai-key"]);
        } finally {
          await fs.rm(dir, { recursive: true, force: true });
        }
      },
    );
  });
});
