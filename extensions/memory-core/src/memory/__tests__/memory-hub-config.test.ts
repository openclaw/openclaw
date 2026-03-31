import { mkdir, rm, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../engine-host-api.js";
import { resolveMemoryHubConfig } from "../memory-hub-config.js";

function createConfig(memoryHub?: {
  readVisibility?: "private" | "shared" | "auto";
  searchVisibility?: "private" | "shared";
}): OpenClawConfig {
  return {
    agents: {
      defaults: {
        memorySearch: {
          provider: "memory-hub",
          memoryHub,
        },
      },
      list: [{ id: "main", default: true, workspace: "/tmp/workspace" }],
    },
  } as OpenClawConfig;
}

afterEach(() => {
  delete process.env.MEMORY_HUB_READ_VISIBILITY;
  delete process.env.MEMORY_HUB_SEARCH_VISIBILITY;
});

describe("resolveMemoryHubConfig visibility env parsing", () => {
  it("ignores invalid visibility env values", async () => {
    process.env.MEMORY_HUB_READ_VISIBILITY = "invalid";
    process.env.MEMORY_HUB_SEARCH_VISIBILITY = "invalid";

    const resolved = await resolveMemoryHubConfig({
      cfg: createConfig(),
      agentId: "main",
    });

    expect(resolved.readVisibility).toBeUndefined();
    expect(resolved.searchVisibility).toBe("private");
  });

  it("normalizes valid visibility env values", async () => {
    process.env.MEMORY_HUB_READ_VISIBILITY = " AUTO ";
    process.env.MEMORY_HUB_SEARCH_VISIBILITY = " Shared ";

    const resolved = await resolveMemoryHubConfig({
      cfg: createConfig(),
      agentId: "main",
    });

    expect(resolved.readVisibility).toBe("auto");
    expect(resolved.searchVisibility).toBe("shared");
  });

  it("normalizes valid visibility values from config", async () => {
    const configWithMixedCase = {
      agents: {
        defaults: {
          memorySearch: {
            provider: "memory-hub",
            memoryHub: {
              readVisibility: " AUTO ",
              searchVisibility: " Shared ",
            },
          },
        },
        list: [{ id: "main", default: true, workspace: "/tmp/workspace" }],
      },
    } as unknown as OpenClawConfig;

    const resolved = await resolveMemoryHubConfig({
      cfg: configWithMixedCase,
      agentId: "main",
    });

    expect(resolved.readVisibility).toBe("auto");
    expect(resolved.searchVisibility).toBe("shared");
  });

  it("prefers normalized config visibility values over YAML and env", async () => {
    process.env.MEMORY_HUB_READ_VISIBILITY = "private";
    process.env.MEMORY_HUB_SEARCH_VISIBILITY = "private";

    const prevCwd = process.cwd();
    const tmpRoot = `/tmp/memory-hub-config-test-${Date.now()}-config-normalize-priority`;
    await mkdir(`${tmpRoot}/config`, { recursive: true });
    await writeFile(
      `${tmpRoot}/config/memory-hub.yml`,
      ["memoryHub:", "  readVisibility: shared", "  searchVisibility: private"].join("\n"),
      "utf8",
    );
    process.chdir(tmpRoot);

    try {
      const configWithMixedCase = {
        agents: {
          defaults: {
            memorySearch: {
              provider: "memory-hub",
              memoryHub: {
                readVisibility: " AUTO ",
                searchVisibility: " Shared ",
              },
            },
          },
          list: [{ id: "main", default: true, workspace: "/tmp/workspace" }],
        },
      } as unknown as OpenClawConfig;

      const resolved = await resolveMemoryHubConfig({
        cfg: configWithMixedCase,
        agentId: "main",
      });

      expect(resolved.readVisibility).toBe("auto");
      expect(resolved.searchVisibility).toBe("shared");
    } finally {
      process.chdir(prevCwd);
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it("normalizes valid visibility values from YAML", async () => {
    const prevCwd = process.cwd();
    const tmpRoot = `/tmp/memory-hub-config-test-${Date.now()}-yaml-normalize`;
    await mkdir(`${tmpRoot}/config`, { recursive: true });
    await writeFile(
      `${tmpRoot}/config/memory-hub.yml`,
      ["memoryHub:", "  readVisibility: ' AUTO '", "  searchVisibility: ' Shared '"].join("\n"),
      "utf8",
    );
    process.chdir(tmpRoot);

    try {
      const resolved = await resolveMemoryHubConfig({
        cfg: createConfig(),
        agentId: "main",
      });

      expect(resolved.readVisibility).toBe("auto");
      expect(resolved.searchVisibility).toBe("shared");
    } finally {
      process.chdir(prevCwd);
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it("ignores invalid visibility values from config and falls back to env/default", async () => {
    process.env.MEMORY_HUB_READ_VISIBILITY = "shared";
    process.env.MEMORY_HUB_SEARCH_VISIBILITY = "shared";

    const invalidConfig = {
      agents: {
        defaults: {
          memorySearch: {
            provider: "memory-hub",
            memoryHub: {
              readVisibility: "invalid",
              searchVisibility: "invalid",
            },
          },
        },
        list: [{ id: "main", default: true, workspace: "/tmp/workspace" }],
      },
    } as unknown as OpenClawConfig;

    const resolved = await resolveMemoryHubConfig({
      cfg: invalidConfig,
      agentId: "main",
    });

    expect(resolved.readVisibility).toBe("shared");
    expect(resolved.searchVisibility).toBe("shared");
  });

  it("ignores invalid visibility values from config and falls back to defaults", async () => {
    const invalidConfig = {
      agents: {
        defaults: {
          memorySearch: {
            provider: "memory-hub",
            memoryHub: {
              readVisibility: "invalid",
              searchVisibility: "invalid",
            },
          },
        },
        list: [{ id: "main", default: true, workspace: "/tmp/workspace" }],
      },
    } as unknown as OpenClawConfig;

    const resolved = await resolveMemoryHubConfig({
      cfg: invalidConfig,
      agentId: "main",
    });

    expect(resolved.readVisibility).toBeUndefined();
    expect(resolved.searchVisibility).toBe("private");
  });

  it("ignores invalid visibility values from config and falls back to YAML before env", async () => {
    process.env.MEMORY_HUB_READ_VISIBILITY = "private";
    process.env.MEMORY_HUB_SEARCH_VISIBILITY = "private";

    const prevCwd = process.cwd();
    const tmpRoot = `/tmp/memory-hub-config-test-${Date.now()}-yaml-priority`;
    await mkdir(`${tmpRoot}/config`, { recursive: true });
    await writeFile(
      `${tmpRoot}/config/memory-hub.yml`,
      ["memoryHub:", "  readVisibility: shared", "  searchVisibility: shared"].join("\n"),
      "utf8",
    );
    process.chdir(tmpRoot);

    try {
      const invalidConfig = {
        agents: {
          defaults: {
            memorySearch: {
              provider: "memory-hub",
              memoryHub: {
                readVisibility: "invalid",
                searchVisibility: "invalid",
              },
            },
          },
          list: [{ id: "main", default: true, workspace: "/tmp/workspace" }],
        },
      } as unknown as OpenClawConfig;

      const resolved = await resolveMemoryHubConfig({
        cfg: invalidConfig,
        agentId: "main",
      });

      expect(resolved.readVisibility).toBe("shared");
      expect(resolved.searchVisibility).toBe("shared");
    } finally {
      process.chdir(prevCwd);
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it("ignores invalid visibility values from config and falls back to normalized YAML before env", async () => {
    process.env.MEMORY_HUB_READ_VISIBILITY = "private";
    process.env.MEMORY_HUB_SEARCH_VISIBILITY = "private";

    const prevCwd = process.cwd();
    const tmpRoot = `/tmp/memory-hub-config-test-${Date.now()}-yaml-normalized-priority`;
    await mkdir(`${tmpRoot}/config`, { recursive: true });
    await writeFile(
      `${tmpRoot}/config/memory-hub.yml`,
      ["memoryHub:", "  readVisibility: ' Shared '", "  searchVisibility: ' Private '"].join("\n"),
      "utf8",
    );
    process.chdir(tmpRoot);

    try {
      const invalidConfig = {
        agents: {
          defaults: {
            memorySearch: {
              provider: "memory-hub",
              memoryHub: {
                readVisibility: "invalid",
                searchVisibility: "invalid",
              },
            },
          },
          list: [{ id: "main", default: true, workspace: "/tmp/workspace" }],
        },
      } as unknown as OpenClawConfig;

      const resolved = await resolveMemoryHubConfig({
        cfg: invalidConfig,
        agentId: "main",
      });

      expect(resolved.readVisibility).toBe("shared");
      expect(resolved.searchVisibility).toBe("private");
    } finally {
      process.chdir(prevCwd);
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it("ignores invalid visibility values from YAML and falls back to env/default", async () => {
    process.env.MEMORY_HUB_READ_VISIBILITY = "shared";
    process.env.MEMORY_HUB_SEARCH_VISIBILITY = "shared";

    const prevCwd = process.cwd();
    const tmpRoot = `/tmp/memory-hub-config-test-${Date.now()}`;
    await mkdir(`${tmpRoot}/config`, { recursive: true });
    await writeFile(
      `${tmpRoot}/config/memory-hub.yml`,
      ["memoryHub:", "  readVisibility: invalid", "  searchVisibility: invalid"].join("\n"),
      "utf8",
    );
    process.chdir(tmpRoot);

    try {
      const resolved = await resolveMemoryHubConfig({
        cfg: createConfig(),
        agentId: "main",
      });

      expect(resolved.readVisibility).toBe("shared");
      expect(resolved.searchVisibility).toBe("shared");
    } finally {
      process.chdir(prevCwd);
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it("prefers YAML visibility values over normalized env values", async () => {
    process.env.MEMORY_HUB_READ_VISIBILITY = " AUTO ";
    process.env.MEMORY_HUB_SEARCH_VISIBILITY = " Shared ";

    const prevCwd = process.cwd();
    const tmpRoot = `/tmp/memory-hub-config-test-${Date.now()}-yaml-over-env`;
    await mkdir(`${tmpRoot}/config`, { recursive: true });
    await writeFile(
      `${tmpRoot}/config/memory-hub.yml`,
      ["memoryHub:", "  readVisibility: shared", "  searchVisibility: private"].join("\n"),
      "utf8",
    );
    process.chdir(tmpRoot);

    try {
      const resolved = await resolveMemoryHubConfig({
        cfg: createConfig(),
        agentId: "main",
      });

      expect(resolved.readVisibility).toBe("shared");
      expect(resolved.searchVisibility).toBe("private");
    } finally {
      process.chdir(prevCwd);
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it("prefers normalized YAML visibility values over normalized env values", async () => {
    process.env.MEMORY_HUB_READ_VISIBILITY = " auto ";
    process.env.MEMORY_HUB_SEARCH_VISIBILITY = " shared ";

    const prevCwd = process.cwd();
    const tmpRoot = `/tmp/memory-hub-config-test-${Date.now()}-yaml-env-normalized-priority`;
    await mkdir(`${tmpRoot}/config`, { recursive: true });
    await writeFile(
      `${tmpRoot}/config/memory-hub.yml`,
      ["memoryHub:", "  readVisibility: ' Shared '", "  searchVisibility: ' Private '"].join("\n"),
      "utf8",
    );
    process.chdir(tmpRoot);

    try {
      const resolved = await resolveMemoryHubConfig({
        cfg: createConfig(),
        agentId: "main",
      });

      expect(resolved.readVisibility).toBe("shared");
      expect(resolved.searchVisibility).toBe("private");
    } finally {
      process.chdir(prevCwd);
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it("ignores invalid visibility values from YAML and falls back to defaults", async () => {
    const prevCwd = process.cwd();
    const tmpRoot = `/tmp/memory-hub-config-test-${Date.now()}-yaml-default`;
    await mkdir(`${tmpRoot}/config`, { recursive: true });
    await writeFile(
      `${tmpRoot}/config/memory-hub.yml`,
      ["memoryHub:", "  readVisibility: invalid", "  searchVisibility: invalid"].join("\n"),
      "utf8",
    );
    process.chdir(tmpRoot);

    try {
      const resolved = await resolveMemoryHubConfig({
        cfg: createConfig(),
        agentId: "main",
      });

      expect(resolved.readVisibility).toBeUndefined();
      expect(resolved.searchVisibility).toBe("private");
    } finally {
      process.chdir(prevCwd);
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });
});
