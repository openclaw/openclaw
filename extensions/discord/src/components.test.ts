import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MessageFlags } from "discord-api-types/v10";
import { resolveGlobalMap } from "openclaw/plugin-sdk/global-singleton";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

let clearDiscordComponentEntries: typeof import("./components-registry.js").clearDiscordComponentEntries;
let registerDiscordComponentEntries: typeof import("./components-registry.js").registerDiscordComponentEntries;
let resolveDiscordComponentEntry: typeof import("./components-registry.js").resolveDiscordComponentEntry;
let resolveDiscordModalEntry: typeof import("./components-registry.js").resolveDiscordModalEntry;
let buildDiscordComponentMessage: typeof import("./components.js").buildDiscordComponentMessage;
let buildDiscordComponentMessageFlags: typeof import("./components.js").buildDiscordComponentMessageFlags;
let readDiscordComponentSpec: typeof import("./components.js").readDiscordComponentSpec;
const ORIGINAL_HOME = process.env.HOME;

beforeAll(async () => {
  ({
    clearDiscordComponentEntries,
    registerDiscordComponentEntries,
    resolveDiscordComponentEntry,
    resolveDiscordModalEntry,
  } = await import("./components-registry.js"));
  ({ buildDiscordComponentMessage, buildDiscordComponentMessageFlags, readDiscordComponentSpec } =
    await import("./components.js"));
});

describe("discord components", () => {
  it("builds v2 containers with modal trigger", () => {
    const spec = readDiscordComponentSpec({
      text: "Choose a path",
      blocks: [
        {
          type: "actions",
          buttons: [{ label: "Approve", style: "success", callbackData: "codex:approve" }],
        },
      ],
      modal: {
        title: "Details",
        callbackData: "codex:modal",
        allowedUsers: ["discord:user-1"],
        fields: [{ type: "text", label: "Requester" }],
      },
    });
    if (!spec) {
      throw new Error("Expected component spec to be parsed");
    }

    const result = buildDiscordComponentMessage({ spec });
    expect(result.components).toHaveLength(1);
    expect(result.components[0]?.isV2).toBe(true);
    expect(buildDiscordComponentMessageFlags(result.components)).toBe(MessageFlags.IsComponentsV2);
    expect(result.modals).toHaveLength(1);

    const trigger = result.entries.find((entry) => entry.kind === "modal-trigger");
    expect(trigger?.modalId).toBe(result.modals[0]?.id);
    expect(result.entries.find((entry) => entry.kind === "button")?.callbackData).toBe(
      "codex:approve",
    );
    expect(result.modals[0]?.callbackData).toBe("codex:modal");
    expect(result.modals[0]?.allowedUsers).toEqual(["discord:user-1"]);
  });

  it("requires options for modal select fields", () => {
    expect(() =>
      readDiscordComponentSpec({
        modal: {
          title: "Details",
          fields: [{ type: "select", label: "Priority" }],
        },
      }),
    ).toThrow("options");
  });

  it("requires attachment references for file blocks", () => {
    expect(() =>
      readDiscordComponentSpec({
        blocks: [{ type: "file", file: "https://example.com/report.pdf" }],
      }),
    ).toThrow("attachment://");
    expect(() =>
      readDiscordComponentSpec({
        blocks: [{ type: "file", file: "attachment://" }],
      }),
    ).toThrow("filename");
  });
});

describe("discord component registry", () => {
  const registryDirCleanup = new Set<string>();

  function clearRegistryStores() {
    resolveGlobalMap<string, unknown>(Symbol.for("openclaw.discord.componentEntries")).clear();
    resolveGlobalMap<string, unknown>(Symbol.for("openclaw.discord.modalEntries")).clear();
  }

  async function waitForPersist() {
    await new Promise((resolve) => setImmediate(resolve));
  }

  beforeEach(() => {
    clearDiscordComponentEntries();
    clearRegistryStores();
  });

  afterEach(() => {
    delete process.env.OPENCLAW_DISCORD_COMPONENT_REGISTRY_FILE;
    if (ORIGINAL_HOME === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = ORIGINAL_HOME;
    }
    clearRegistryStores();
    for (const dir of registryDirCleanup) {
      rmSync(dir, { recursive: true, force: true });
    }
    registryDirCleanup.clear();
  });

  const componentsRegistryModuleUrl = new URL("./components-registry.ts", import.meta.url).href;

  it("registers and consumes component entries", () => {
    registerDiscordComponentEntries({
      entries: [{ id: "btn_1", kind: "button", label: "Confirm" }],
      modals: [
        {
          id: "mdl_1",
          title: "Details",
          fields: [{ id: "fld_1", name: "name", label: "Name", type: "text" }],
        },
      ],
      messageId: "msg_1",
      ttlMs: 1000,
    });

    const entry = resolveDiscordComponentEntry({ id: "btn_1", consume: false });
    expect(entry?.messageId).toBe("msg_1");

    const modal = resolveDiscordModalEntry({ id: "mdl_1", consume: false });
    expect(modal?.messageId).toBe("msg_1");

    const consumed = resolveDiscordComponentEntry({ id: "btn_1" });
    expect(consumed?.id).toBe("btn_1");
    expect(resolveDiscordComponentEntry({ id: "btn_1" })).toBeNull();
  });

  it("shares registry state across duplicate module instances", async () => {
    const first = (await import(
      `${componentsRegistryModuleUrl}?t=first-${Date.now()}`
    )) as typeof import("./components-registry.js");
    const second = (await import(
      `${componentsRegistryModuleUrl}?t=second-${Date.now()}`
    )) as typeof import("./components-registry.js");

    first.clearDiscordComponentEntries();
    first.registerDiscordComponentEntries({
      entries: [{ id: "btn_shared", kind: "button", label: "Shared" }],
      modals: [],
    });

    expect(second.resolveDiscordComponentEntry({ id: "btn_shared", consume: false })).toMatchObject(
      {
        id: "btn_shared",
        label: "Shared",
      },
    );

    second.clearDiscordComponentEntries();
  });

  it("reloads persisted route overrides, allowlists, and custom TTL values", async () => {
    const tempHome = mkdtempSync(join(tmpdir(), "openclaw-registry-home-"));
    registryDirCleanup.add(tempHome);
    process.env.HOME = tempHome;
    const registryFile = join(
      tempHome,
      ".openclaw",
      "cache",
      "discord-component-registry.json",
    );
    process.env.OPENCLAW_DISCORD_COMPONENT_REGISTRY_FILE = registryFile;
    const first = (await import(
      `${componentsRegistryModuleUrl}?t=persist-first-${Date.now()}`
    )) as typeof import("./components-registry.js");
    const second = (await import(
      `${componentsRegistryModuleUrl}?t=persist-second-${Date.now()}`
    )) as typeof import("./components-registry.js");

    first.registerDiscordComponentEntries({
      entries: [
        {
          id: "btn_persist",
          kind: "button",
          label: "Persisted",
          sessionKey: "agent:main:discord:channel:c1",
          agentId: "main",
          accountId: "discord-default",
          allowedUsers: ["discord:user-1"],
        },
      ],
      modals: [
        {
          id: "mdl_persist",
          title: "Persisted modal",
          sessionKey: "agent:main:discord:channel:c1",
          agentId: "main",
          accountId: "discord-default",
          allowedUsers: ["discord:user-1"],
          fields: [{ id: "fld_1", name: "name", label: "Name", type: "text" }],
        },
      ],
      ttlMs: 3 * 60 * 60 * 1000,
      messageId: "msg_persist",
    });
    const beforeReload = first.resolveDiscordComponentEntry({ id: "btn_persist", consume: false });
    expect(beforeReload?.expiresAt).toBeDefined();

    await waitForPersist();
    clearRegistryStores();

    const reloaded = second.resolveDiscordComponentEntry({ id: "btn_persist", consume: false });
    const reloadedModal = second.resolveDiscordModalEntry({ id: "mdl_persist", consume: false });

    expect(reloaded).toMatchObject({
      id: "btn_persist",
      sessionKey: "agent:main:discord:channel:c1",
      agentId: "main",
      accountId: "discord-default",
      allowedUsers: ["discord:user-1"],
      messageId: "msg_persist",
    });
    expect(reloaded?.expiresAt).toBe(beforeReload?.expiresAt);
    expect(reloadedModal).toMatchObject({
      id: "mdl_persist",
      sessionKey: "agent:main:discord:channel:c1",
      agentId: "main",
      accountId: "discord-default",
      allowedUsers: ["discord:user-1"],
      messageId: "msg_persist",
    });
    expect(reloadedModal?.expiresAt).toBeDefined();
    expect(existsSync(registryFile)).toBe(true);
  });

  it("treats invalid registry paths as best-effort instead of throwing", async () => {
    const tempHome = mkdtempSync(join(tmpdir(), "openclaw-registry-home-"));
    registryDirCleanup.add(tempHome);
    process.env.HOME = tempHome;
    process.env.OPENCLAW_DISCORD_COMPONENT_REGISTRY_FILE = join(tempHome, "..", "outside-registry.json");
    const registry = (await import(
      `${componentsRegistryModuleUrl}?t=invalid-path-${Date.now()}`
    )) as typeof import("./components-registry.js");

    expect(() =>
      registry.registerDiscordComponentEntries({
        entries: [{ id: "btn_invalid", kind: "button", label: "Still works" }],
        modals: [],
      }),
    ).not.toThrow();
    await waitForPersist();

    expect(registry.resolveDiscordComponentEntry({ id: "btn_invalid", consume: false })).toMatchObject(
      {
        id: "btn_invalid",
        label: "Still works",
      },
    );
    expect(() => registry.clearDiscordComponentEntries()).not.toThrow();
  });
});
