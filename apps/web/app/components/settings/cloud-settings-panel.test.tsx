// @vitest-environment jsdom

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CloudSettingsPanel } from "./cloud-settings-panel";

vi.mock("../integrations/dench-integrations-section", () => ({
  DenchIntegrationsSection: () => <div>Mock Integrations</div>,
}));

const baseState = {
  status: "valid" as const,
  apiKeySource: "config" as const,
  gatewayUrl: "https://gateway.merseoriginals.com",
  primaryModel: null,
  isDenchPrimary: false,
  selectedDenchModel: null,
  selectedVoiceId: null,
  elevenLabsEnabled: true,
  models: [
    {
      id: "claude-opus-4.6",
      stableId: "anthropic.claude-opus-4-6-v1",
      displayName: "Claude Opus 4.6",
      provider: "anthropic",
      reasoning: true,
    },
    {
      id: "gpt-5.4",
      stableId: "gpt-5.4",
      displayName: "GPT-5.4",
      provider: "openai",
      reasoning: true,
    },
  ],
  recommendedModelId: "claude-opus-4.6",
};

const voicesPayload = {
  voices: [
    {
      voiceId: "voice_123",
      name: "Rachel",
      description: "Warm narration voice",
      category: "premade",
      previewUrl: null,
      labels: [],
    },
  ],
};

describe("CloudSettingsPanel", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("shows the rich picker placeholder when Dench Cloud is not primary", async () => {
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/settings/cloud") {
        return new Response(JSON.stringify(baseState));
      }
      if (url === "/api/voice/voices") {
        return new Response(JSON.stringify(voicesPayload));
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }) as typeof fetch;

    render(<CloudSettingsPanel />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Select primary model" })).toBeInTheDocument();
    });

    expect(screen.getByText("Choose a model...")).toBeInTheDocument();
    expect(screen.getByText("Mock Integrations")).toBeInTheDocument();
  });

  it("selects a model through the rich picker and keeps the existing POST flow", async () => {
    const user = userEvent.setup();

    global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/settings/cloud" && (!init || init.method === undefined)) {
        return new Response(JSON.stringify(baseState));
      }
      if (url === "/api/voice/voices") {
        return new Response(JSON.stringify(voicesPayload));
      }

      if (url === "/api/settings/cloud" && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as { action: string; stableId: string };
        expect(body).toEqual({ action: "select_model", stableId: "gpt-5.4" });
        return new Response(JSON.stringify({
          state: {
            ...baseState,
            isDenchPrimary: true,
            selectedDenchModel: "gpt-5.4",
          },
          refresh: {
            attempted: true,
            restarted: true,
            error: null,
            profile: "dench",
          },
        }));
      }

      throw new Error(`Unexpected fetch: ${url}`);
    }) as typeof fetch;

    render(<CloudSettingsPanel />);

    await user.click(await screen.findByRole("button", { name: "Select primary model" }));
    await user.click(await screen.findByText("GPT-5.4"));

    await waitFor(() => {
      expect(screen.getByText("Switched to GPT-5.4 and the dench gateway restarted successfully.")).toBeInTheDocument();
    });
  });

  it("saves the selected ElevenLabs voice", async () => {
    const user = userEvent.setup();

    global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/settings/cloud" && (!init || init.method === undefined)) {
        return new Response(JSON.stringify(baseState));
      }
      if (url === "/api/voice/voices") {
        return new Response(JSON.stringify(voicesPayload));
      }
      if (url === "/api/settings/cloud" && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as { action: string; voiceId: string };
        expect(body).toEqual({ action: "save_voice", voiceId: "voice_123" });
        return new Response(JSON.stringify({
          state: {
            ...baseState,
            selectedVoiceId: "voice_123",
          },
          refresh: {
            attempted: false,
            restarted: false,
            error: null,
            profile: "default",
          },
        }));
      }

      throw new Error(`Unexpected fetch: ${url}`);
    }) as typeof fetch;

    render(<CloudSettingsPanel />);

    const voiceSelect = await screen.findByRole("combobox", { name: "Select ElevenLabs voice" });
    await waitFor(() => {
      expect(screen.getByRole("option", { name: /Rachel/ })).toBeInTheDocument();
      expect(voiceSelect).not.toBeDisabled();
    });
    await user.selectOptions(voiceSelect, "voice_123");

    await waitFor(() => {
      expect(screen.getByText("Saved Rachel for ElevenLabs playback.")).toBeInTheDocument();
    });
  });
});
