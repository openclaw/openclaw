import type { ModelsProviderData } from "openclaw/plugin-sdk/models-provider-runtime";
import { describe, expect, it } from "vitest";
import { serializePayload } from "../internal/discord.js";
import { createModelsProviderData } from "./model-picker.test-utils.js";
import {
  renderDiscordModelPickerModelsView,
  renderDiscordModelPickerProvidersView,
  renderDiscordModelPickerRecentsView,
} from "./model-picker.view.js";

const scope = { command: "models" as const, userId: "42" };
const views = [
  {
    name: "providers",
    choice: '"value":"openai"',
    render: (data: ModelsProviderData) => renderDiscordModelPickerProvidersView({ ...scope, data }),
  },
  {
    name: "models",
    choice: '"value":"gpt-4.1"',
    render: (data: ModelsProviderData) =>
      renderDiscordModelPickerModelsView({ ...scope, data, provider: "openai" }),
  },
  {
    name: "recents",
    choice: '"label":"openai/gpt-4.1 (default)"',
    render: (data: ModelsProviderData) =>
      renderDiscordModelPickerRecentsView({ ...scope, data, quickModels: ["openai/gpt-4.1"] }),
  },
];

describe("model picker refresh warnings", () => {
  it.each(views)("keeps choices and clears a recovered warning in $name", ({ render, choice }) => {
    const data: ModelsProviderData = {
      ...createModelsProviderData({ openai: ["gpt-4.1"] }),
      refreshWarning: "Some models could not be refreshed.",
    };
    const failedRefresh = JSON.stringify(serializePayload(render(data)));
    expect(failedRefresh).toContain("Some models could not be refreshed.");
    expect(failedRefresh).toContain(choice);
    delete data.refreshWarning;
    const recovered = JSON.stringify(serializePayload(render(data)));
    expect(recovered).not.toContain("Some models could not be refreshed.");
    expect(recovered).toContain(choice);
  });
});
