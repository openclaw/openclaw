import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearSessionStoreCacheForTest } from "../../../../src/config/sessions.js";
import {
  buildZulipModelPickerReply,
  resolveZulipModelPickerCallbackAction,
} from "./model-picker.js";

const STORE_PATH = path.join(os.tmpdir(), "openclaw-zulip-model-picker-test.json");

vi.mock("../../../../src/agents/model-catalog.js", () => ({
  loadModelCatalog: vi.fn(async () => [
    { provider: "openai", id: "gpt-4.1", name: "GPT-4.1" },
    { provider: "openai", id: "gpt-4.1-mini", name: "GPT-4.1 Mini" },
    { provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" },
  ]),
}));

function writeStore(store: Record<string, unknown>) {
  fs.writeFileSync(STORE_PATH, `${JSON.stringify(store, null, 2)}\n`, "utf8");
  clearSessionStoreCacheForTest();
}

describe("resolveZulipModelPickerCallbackAction", () => {
  const cfg = {
    session: { store: STORE_PATH },
    agents: {
      defaults: {
        model: "openai/gpt-4.1",
      },
    },
  };
  const sessionKey = "agent:archie:zulip:stream:ops:topic:deploy";

  beforeEach(() => {
    writeStore({
      [sessionKey]: {
        sessionId: "s1",
        updatedAt: Date.now(),
        providerOverride: "openai",
        modelOverride: "gpt-4.1-mini",
      },
    });
  });

  it("builds a provider page for mdl_prov with invoker ACLs", async () => {
    const action = await resolveZulipModelPickerCallbackAction({
      cfg,
      callbackData: "mdl_prov",
      agentId: "archie",
      sessionKey,
      allowedUserIds: [42],
    });

    expect(action).toMatchObject({ kind: "render" });
    if (!action || action.kind !== "render") {
      throw new Error("expected render action");
    }
    expect(action.render.text).toBe("Select a provider:");
    expect(action.render.spec.heading).toBe("Model Providers");
    expect(action.render.spec.buttons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: "anthropic (1)",
          callbackData: "mdl_list_anthropic_1",
          allowedUsers: [42],
        }),
        expect.objectContaining({
          label: "openai (2)",
          callbackData: "mdl_list_openai_1",
          allowedUsers: [42],
        }),
      ]),
    );
  });

  it("builds a model page with the current override marked and keeps invoker ACLs", async () => {
    const action = await resolveZulipModelPickerCallbackAction({
      cfg,
      callbackData: "mdl_list_openai_1",
      agentId: "archie",
      sessionKey,
      allowedUserIds: [42],
    });

    expect(action).toMatchObject({ kind: "render" });
    if (!action || action.kind !== "render") {
      throw new Error("expected render action");
    }
    expect(action.render.text).toContain("Models (openai");
    expect(action.render.spec.buttons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: expect.stringContaining("gpt-4.1-mini ✓"),
          allowedUsers: [42],
        }),
        expect.objectContaining({
          label: "<< Back",
          callbackData: "mdl_back",
          allowedUsers: [42],
        }),
      ]),
    );
  });

  it("preserves allowed users in Zulip reply payloads", () => {
    const reply = buildZulipModelPickerReply({
      text: "Select a provider:",
      spec: {
        heading: "Model Providers",
        buttons: [
          {
            label: "openai (2)",
            callbackData: "mdl_list_openai_1",
            allowedUsers: [42],
          },
        ],
      },
    });

    expect(reply.channelData?.zulip).toEqual({
      heading: "Model Providers",
      buttons: [
        {
          text: "openai (2)",
          callback_data: "mdl_list_openai_1",
          style: undefined,
          allowed_users: [42],
        },
      ],
    });
  });

  it("resolves model selection callbacks to a synthetic /model command", async () => {
    const action = await resolveZulipModelPickerCallbackAction({
      cfg,
      callbackData: "mdl_sel_openai/gpt-4.1",
      agentId: "archie",
      sessionKey,
    });

    expect(action).toEqual({ kind: "command", commandText: "/model openai/gpt-4.1" });
  });
});
