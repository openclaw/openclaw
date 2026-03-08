import { mkdtempSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveImplicitProviders } from "./models-config.providers.js";

describe("minimax provider catalog", () => {
  it("does not advertise the removed lightning model for api-key or oauth providers", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "openclaw-test-"));
    await writeFile(
      join(agentDir, "auth-profiles.json"),
      JSON.stringify(
        {
          version: 1,
          profiles: {
            "minimax:default": {
              type: "api_key",
              provider: "minimax",
              key: "sk-minimax-test", // pragma: allowlist secret
            },
            "minimax-portal:default": {
              type: "oauth",
              provider: "minimax-portal",
              access: "access-token",
              refresh: "refresh-token",
              expires: Date.now() + 60_000,
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const providers = await resolveImplicitProviders({ agentDir });
    expect(providers?.minimax?.models?.map((model) => model.id)).toEqual([
      "MiniMax-VL-01",
      "MiniMax-M2.5",
      "MiniMax-M2.5-highspeed",
    ]);
    expect(providers?.["minimax-portal"]?.models?.map((model) => model.id)).toEqual([
      "MiniMax-VL-01",
      "MiniMax-M2.5",
      "MiniMax-M2.5-highspeed",
    ]);
  });
});
