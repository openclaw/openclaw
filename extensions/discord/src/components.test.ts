import { MessageFlags } from "discord-api-types/v10";
import { describe, expect, it, vi } from "vitest";
import { withStateDirEnv } from "../../../src/test-helpers/state-dir-env.js";
import {
  buildDiscordComponentMessage,
  buildDiscordComponentMessageFlags,
  readDiscordComponentSpec,
} from "./components.js";

describe("discord components", () => {
  it("builds v2 containers with modal trigger", () => {
    const spec = readDiscordComponentSpec({
      text: "Choose a path",
      blocks: [
        {
          type: "actions",
          buttons: [{ label: "Approve", style: "success" }],
        },
      ],
      modal: {
        title: "Details",
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
  async function importRegistryModule() {
    vi.resetModules();
    return import("./components-registry.js");
  }

  it("registers and consumes component entries", async () => {
    await withStateDirEnv("openclaw-discord-components-registry-", async () => {
      const registry = await importRegistryModule();
      registry.clearDiscordComponentEntries();
      registry.registerDiscordComponentEntries({
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

      const entry = registry.resolveDiscordComponentEntry({ id: "btn_1", consume: false });
      expect(entry?.messageId).toBe("msg_1");

      const modal = registry.resolveDiscordModalEntry({ id: "mdl_1", consume: false });
      expect(modal?.messageId).toBe("msg_1");

      const consumed = registry.resolveDiscordComponentEntry({ id: "btn_1" });
      expect(consumed?.id).toBe("btn_1");
      expect(registry.resolveDiscordComponentEntry({ id: "btn_1" })).toBeNull();
    });
  });

  it("rehydrates component entries after a simulated restart", async () => {
    await withStateDirEnv("openclaw-discord-components-registry-", async () => {
      const firstLoad = await importRegistryModule();
      firstLoad.clearDiscordComponentEntries();
      firstLoad.registerDiscordComponentEntries({
        entries: [{ id: "btn_restart", kind: "button", label: "Rehydrate" }],
        modals: [
          {
            id: "mdl_restart",
            title: "Restart Form",
            fields: [{ id: "fld_1", name: "name", label: "Name", type: "text" }],
          },
        ],
        messageId: "msg_restart",
        ttlMs: 60_000,
      });

      const reloaded = await importRegistryModule();
      const component = reloaded.resolveDiscordComponentEntry({
        id: "btn_restart",
        consume: false,
      });
      expect(component).toMatchObject({
        id: "btn_restart",
        messageId: "msg_restart",
      });

      const modal = reloaded.resolveDiscordModalEntry({ id: "mdl_restart", consume: false });
      expect(modal).toMatchObject({
        id: "mdl_restart",
        messageId: "msg_restart",
      });
    });
  });

  it("prunes expired entries after a simulated restart", async () => {
    await withStateDirEnv("openclaw-discord-components-registry-", async () => {
      const firstLoad = await importRegistryModule();
      firstLoad.clearDiscordComponentEntries();
      const expiredAt = Date.now() - 1_000;
      firstLoad.registerDiscordComponentEntries({
        entries: [
          {
            id: "btn_expired",
            kind: "button",
            label: "Expired",
            createdAt: expiredAt - 1_000,
            expiresAt: expiredAt,
          },
        ],
        modals: [
          {
            id: "mdl_expired",
            title: "Expired Form",
            createdAt: expiredAt - 1_000,
            expiresAt: expiredAt,
            fields: [{ id: "fld_1", name: "name", label: "Name", type: "text" }],
          },
        ],
      });

      const reloaded = await importRegistryModule();
      expect(
        reloaded.resolveDiscordComponentEntry({ id: "btn_expired", consume: false }),
      ).toBeNull();
      expect(reloaded.resolveDiscordModalEntry({ id: "mdl_expired", consume: false })).toBeNull();
    });
  });
});
