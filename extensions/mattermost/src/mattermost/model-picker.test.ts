// Mattermost tests cover model picker plugin behavior.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../runtime-api.js";
import { setInteractionSecret } from "./interactions.js";
import {
  buildMattermostModelPickerDialog,
  buildMattermostModelPickerDialogState,
  buildMattermostModelPickerSelectionCommand,
  buildMattermostAllowedModelRefs,
  MATTERMOST_MODEL_PICKER_DIALOG_CALLBACK_ID,
  MATTERMOST_MODEL_PICKER_RUNTIME_KEEP_CURRENT,
  parseMattermostModelPickerDialogState,
  parseMattermostModelPickerContext,
  renderMattermostModelSummaryView,
  renderMattermostModelsPickerView,
  renderMattermostProviderPickerView,
  resolveMattermostModelPickerDialogChannelInfo,
  resolveMattermostModelPickerCurrentModel,
  resolveMattermostModelPickerCurrentRuntime,
  resolveMattermostModelPickerDialogValues,
  resolveMattermostModelPickerEntry,
} from "./model-picker.js";

const data = {
  byProvider: new Map<string, Set<string>>([
    ["anthropic", new Set(["claude-opus-4-5", "claude-sonnet-4-5"])],
    ["openai", new Set(["gpt-4.1", "gpt-5"])],
  ]),
  providers: ["anthropic", "openai"],
  resolvedDefault: {
    provider: "anthropic",
    model: "claude-opus-4-5",
  },
  modelNames: new Map<string, string>(),
};

describe("Mattermost model picker", () => {
  it("round-trips signed dialog state", () => {
    setInteractionSecret("acct", "bot-token");
    const state = buildMattermostModelPickerDialogState({
      ownerUserId: "user-1",
      channelId: "chan-1",
      teamId: "team-1",
      channelInfo: {
        id: "chan-1",
        type: "O",
        name: "secret-planning",
        display_name: "Secret Planning",
        team_id: "team-1",
      },
      accountId: "acct",
    });

    expect(
      parseMattermostModelPickerDialogState({
        state,
        accountId: "acct",
      }),
    ).toEqual({
      v: 1,
      ownerUserId: "user-1",
      channelId: "chan-1",
      teamId: "team-1",
      channelSnapshot: {
        type: "O",
        name: "secret-planning",
        displayName: "Secret Planning",
      },
    });
  });

  it("rejects tampered dialog state", () => {
    setInteractionSecret("acct", "bot-token");
    const state = buildMattermostModelPickerDialogState({
      ownerUserId: "user-1",
      channelId: "chan-1",
      accountId: "acct",
    });
    const decoded = JSON.parse(Buffer.from(state, "base64url").toString("utf8")) as {
      ownerUserId: string;
      channelId: string;
      _token: string;
      v: number;
    };
    decoded.channelId = "chan-2";
    const tampered = Buffer.from(JSON.stringify(decoded), "utf8").toString("base64url");

    expect(
      parseMattermostModelPickerDialogState({
        state: tampered,
        accountId: "acct",
      }),
    ).toBeNull();
  });

  it("resolves bare /model and /models entry points", () => {
    expect(resolveMattermostModelPickerEntry("/model")).toEqual({ kind: "summary" });
    expect(resolveMattermostModelPickerEntry("/models")).toEqual({ kind: "providers" });
    expect(resolveMattermostModelPickerEntry("/models OpenAI")).toEqual({
      kind: "models",
      provider: "openai",
    });
    expect(resolveMattermostModelPickerEntry("/model openai/gpt-5")).toBeNull();
  });

  it("builds the allowed model refs set", () => {
    expect(buildMattermostAllowedModelRefs(data)).toEqual(
      new Set([
        "anthropic/claude-opus-4-5",
        "anthropic/claude-sonnet-4-5",
        "openai/gpt-4.1",
        "openai/gpt-5",
      ]),
    );
  });

  it("renders the summary view with a browse button", () => {
    const view = renderMattermostModelSummaryView({
      ownerUserId: "user-1",
      currentModel: "openai/gpt-5",
    });

    expect(view.text).toContain("Current: openai/gpt-5");
    expect(view.text).toContain("Tap below to browse models");
    expect(view.text).toContain("/oc_model <provider/model> to switch");
    expect(view.text).toContain("Browse keeps the current runtime");
    expect(view.text).toContain("/oc_model <provider/model> --runtime <runtime>");
    const firstRow = view.buttons[0];
    if (!firstRow) {
      throw new Error("expected Mattermost model picker button row");
    }
    const browseButton = firstRow[0];
    if (!browseButton) {
      throw new Error("expected Mattermost browse providers button");
    }
    expect(browseButton.text).toBe("Browse providers");
  });

  it("trims accidental model spacing in Mattermost current-model text", () => {
    const view = renderMattermostModelSummaryView({
      ownerUserId: "user-1",
      currentModel: " OpenAI/ gpt-5 ",
    });

    expect(view.text).toContain("Current: openai/gpt-5");
  });

  it("renders providers and models with Telegram-style navigation", () => {
    const providersView = renderMattermostProviderPickerView({
      ownerUserId: "user-1",
      data,
      currentModel: "openai/gpt-5",
    });
    const providerTexts = providersView.buttons.flat().map((button) => button.text);
    expect(providerTexts).toContain("anthropic (2)");
    expect(providerTexts).toContain("openai (2)");

    const modelsView = renderMattermostModelsPickerView({
      ownerUserId: "user-1",
      data,
      provider: "openai",
      page: 1,
      currentModel: "openai/gpt-5",
    });
    const modelTexts = modelsView.buttons.flat().map((button) => button.text);
    expect(modelsView.text).toContain("Models (openai) - 2 available");
    expect(modelTexts).toContain("gpt-5 [current]");
    expect(modelTexts).toContain("Back to providers");
  });

  it("renders unique alphanumeric action ids per button", () => {
    const modelsView = renderMattermostModelsPickerView({
      ownerUserId: "user-1",
      data,
      provider: "openai",
      page: 1,
      currentModel: "openai/gpt-5",
    });

    const ids = modelsView.buttons.flat().map((button) => button.id);
    expect(ids.every((id) => typeof id === "string" && /^[a-z0-9]+$/.test(id))).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("parses signed picker contexts", () => {
    expect(
      parseMattermostModelPickerContext({
        oc_model_picker: true,
        action: "select",
        ownerUserId: "user-1",
        provider: "openai",
        page: 2,
        model: "gpt-5",
      }),
    ).toEqual({
      action: "select",
      ownerUserId: "user-1",
      provider: "openai",
      page: 2,
      model: "gpt-5",
    });
    expect(parseMattermostModelPickerContext({ action: "select" })).toBeNull();
  });

  it("does not coerce partial page strings in signed picker contexts", () => {
    expect(
      parseMattermostModelPickerContext({
        oc_model_picker: true,
        action: "list",
        ownerUserId: "user-1",
        provider: "openai",
        page: "+02",
      }),
    ).toEqual({
      action: "list",
      ownerUserId: "user-1",
      provider: "openai",
      page: 2,
    });
    expect(
      parseMattermostModelPickerContext({
        oc_model_picker: true,
        action: "list",
        ownerUserId: "user-1",
        provider: "openai",
        page: "2next",
      }),
    ).toEqual({
      action: "list",
      ownerUserId: "user-1",
      provider: "openai",
      page: 1,
    });
  });

  it("falls back to the routed agent default model when no override is stored", () => {
    const testDir = fs.mkdtempSync(path.join(os.tmpdir(), "mm-model-picker-"));
    try {
      const cfg: OpenClawConfig = {
        session: {
          store: path.join(testDir, "{agentId}.json"),
        },
        agents: {
          defaults: {
            model: "anthropic/claude-opus-4-5",
          },
          list: [
            {
              id: "support",
              model: "openai/gpt-5",
            },
          ],
        },
      };
      const providerData = {
        byProvider: new Map<string, Set<string>>([
          ["anthropic", new Set(["claude-opus-4-5"])],
          ["openai", new Set(["gpt-5"])],
        ]),
        providers: ["anthropic", "openai"],
        resolvedDefault: {
          provider: "openai",
          model: "gpt-5",
        },
        modelNames: new Map<string, string>(),
      };

      expect(
        resolveMattermostModelPickerCurrentModel({
          cfg,
          route: {
            agentId: "support",
            sessionKey: "agent:support:main",
          },
          data: providerData,
        }),
      ).toBe("openai/gpt-5");
    } finally {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  it("resolves the current runtime from session overrides and config", () => {
    const testDir = fs.mkdtempSync(path.join(os.tmpdir(), "mm-model-picker-runtime-"));
    try {
      const cfg: OpenClawConfig = {
        session: {
          store: path.join(testDir, "{agentId}.json"),
        },
        agents: {
          defaults: {
            agentRuntime: {
              id: "pi",
            },
          },
          list: [
            {
              id: "support",
              agentRuntime: {
                id: "claude-cli",
              },
            },
          ],
        },
      };

      expect(
        resolveMattermostModelPickerCurrentRuntime({
          cfg,
          route: {
            agentId: "support",
            sessionKey: "agent:support:main",
          },
        }),
      ).toBe("claude-cli");

      fs.writeFileSync(
        path.join(testDir, "support.json"),
        JSON.stringify({
          "agent:support:main": {
            agentRuntimeOverride: "codex",
          },
        }),
      );

      expect(
        resolveMattermostModelPickerCurrentRuntime({
          cfg,
          route: {
            agentId: "support",
            sessionKey: "agent:support:main",
          },
        }),
      ).toBe("codex");
    } finally {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  it("builds a dialog-backed picker with provider, model, and runtime fields", () => {
    setInteractionSecret("acct", "bot-token");
    const dialog = buildMattermostModelPickerDialog({
      accountId: "acct",
      ownerUserId: "user-1",
      channelId: "chan-1",
      teamId: "team-1",
      channelInfo: {
        id: "chan-1",
        type: "D",
        name: "user-1__user-2",
        display_name: "DM",
        team_id: "team-1",
      },
      callbackUrl: "https://gateway.example.com/mattermost/interactions/acct",
      data,
      currentModel: "openai/gpt-5",
      currentRuntime: "claude-cli",
    });

    expect(dialog.callback_id).toBe(MATTERMOST_MODEL_PICKER_DIALOG_CALLBACK_ID);
    expect(dialog.source_url).toBe("https://gateway.example.com/mattermost/interactions/acct");
    expect(dialog.introduction_text).toContain("Current: openai/gpt-5");
    expect(dialog.introduction_text).toContain("Runtime: claude-cli");
    expect(dialog.elements.map((field) => field.name)).toEqual(["provider", "model", "runtime"]);
    expect(dialog.elements[0]?.refresh).toBe(true);
    expect(dialog.elements[2]?.default).toBe(MATTERMOST_MODEL_PICKER_RUNTIME_KEEP_CURRENT);
    const dialogState = parseMattermostModelPickerDialogState({
      state: dialog.state,
      accountId: "acct",
    });
    expect(dialogState).toBeTruthy();
    expect(resolveMattermostModelPickerDialogChannelInfo(dialogState!)).toEqual({
      id: "chan-1",
      type: "D",
      name: "user-1__user-2",
      display_name: "DM",
      team_id: "team-1",
    });
  });

  it("normalizes dialog submission values and preserves keep-current runtime", () => {
    const values = resolveMattermostModelPickerDialogValues({
      submission: {
        provider: "OpenAI",
        model: "gpt-5",
        runtime: MATTERMOST_MODEL_PICKER_RUNTIME_KEEP_CURRENT,
        selected_field: "provider",
      },
      data,
      currentModel: "openai/gpt-5",
      currentRuntime: "claude-cli",
    });

    expect(values).toEqual({
      provider: "openai",
      model: "gpt-5",
      runtimeChoice: MATTERMOST_MODEL_PICKER_RUNTIME_KEEP_CURRENT,
      selectedField: "provider",
    });
  });

  it("builds /model commands that only add runtime flags when needed", () => {
    expect(
      buildMattermostModelPickerSelectionCommand({
        modelRef: "openai/gpt-5",
        runtimeChoice: MATTERMOST_MODEL_PICKER_RUNTIME_KEEP_CURRENT,
      }),
    ).toBe("/model openai/gpt-5");
    expect(
      buildMattermostModelPickerSelectionCommand({
        modelRef: "openai/gpt-5",
        runtimeChoice: "codex",
      }),
    ).toBe("/model openai/gpt-5 --runtime codex");
  });
});
