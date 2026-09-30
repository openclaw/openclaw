// Product proof: a real embedded Gateway turn must bind before_prompt_build to the
// admitted request, so plugins can identify the current input and its admission.
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { afterEach, describe, expect, it } from "vitest";
import { startQaBusServer } from "./bus-server.js";
import { createQaBusState } from "./bus-state.js";
import { createQaGatewayChild } from "./gateway-child.js";
import { startQaMockOpenAiServer } from "./providers/mock-openai/server.js";
import { createQaChannelTransport } from "./qa-channel-transport.js";

const PLUGIN_ID = "qa-prompt-build-current-input-probe";
const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const PLUGIN_DIR = path.join(
  REPO_ROOT,
  "extensions/qa-lab/test-fixtures/prompt-build-current-input-probe",
);
const CONVERSATION = { id: "prompt-build-current-input", kind: "direct" as const };
const USER_TEXT = "PROMPT_BUILD_CURRENT_INPUT_MARKER";

type CapturedEvent = {
  keys: string[];
  hasCurrentUserMessage: boolean;
  currentUserMessage: string | null;
  hasCurrentUserMessageId: boolean;
  currentUserMessageId: string | null;
  prompt: string | null;
  trigger: string | null;
};

function withProbePlugin(config: OpenClawConfig): OpenClawConfig {
  return {
    ...config,
    plugins: {
      ...config.plugins,
      enabled: true,
      allow: [...new Set([...(config.plugins?.allow ?? []), PLUGIN_ID])],
      load: {
        ...config.plugins?.load,
        paths: [...new Set([...(config.plugins?.load?.paths ?? []), PLUGIN_DIR])],
      },
      entries: {
        ...config.plugins?.entries,
        [PLUGIN_ID]: {
          enabled: true,
          hooks: { allowConversationAccess: true, allowPromptInjection: true },
        },
      },
    },
  };
}

describe("embedded prompt-build current input", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).toReversed()) {
      await cleanup();
    }
  });

  it(
    "binds the admitted request onto the prompt boundary event",
    { timeout: 300_000 },
    async () => {
      const state = createQaBusState();
      const transport = createQaChannelTransport(state);
      const bus = await startQaBusServer({ state });
      cleanups.push(() => bus.stop());

      const mock = await startQaMockOpenAiServer();
      cleanups.push(() => mock.stop());

      const gatewayOwner = createQaGatewayChild();
      cleanups.push(async () => {
        await gatewayOwner.stop();
      });
      const gateway = await gatewayOwner.start({
        repoRoot: REPO_ROOT,
        useRepoCli: true,
        providerBaseUrl: `${mock.baseUrl}/v1`,
        providerMode: "mock-openai",
        primaryModel: "mock-openai/gpt-5.6-luna",
        alternateModel: "mock-openai/gpt-5.6-luna-alt",
        transport,
        transportBaseUrl: bus.baseUrl,
        controlUiEnabled: false,
        mutateConfig: withProbePlugin,
      });
      await transport.waitReady({ gateway });

      const outboundStartIndex = state
        .getSnapshot()
        .messages.filter((message) => message.direction === "outbound").length;
      await transport.sendInbound({
        accountId: "default",
        conversation: CONVERSATION,
        senderId: "probe-user",
        text: USER_TEXT,
      });
      await transport.waitForOutbound({
        conversation: CONVERSATION,
        sinceIndex: outboundStartIndex,
        timeoutMs: 180_000,
      });

      const response = await fetch(`${gateway.baseUrl}/qa/prompt-build-current-input`, {
        headers: { Authorization: `Bearer ${gateway.token}` },
        signal: AbortSignal.timeout(30_000),
      });
      expect(response.status).toBe(200);
      const captures = (await response.json()) as { beforePromptBuild: CapturedEvent[] };
      const captured = captures.beforePromptBuild.at(-1);
      expect(captured).toBeDefined();
      expect(captured).toMatchObject({
        hasCurrentUserMessage: true,
        hasCurrentUserMessageId: true,
        currentUserMessage: USER_TEXT,
        trigger: "user",
      });
      expect(captured?.keys).toEqual([
        "currentUserMessage",
        "currentUserMessageId",
        "messages",
        "prompt",
      ]);
      expect(captured?.currentUserMessageId).toEqual(expect.any(String));
      expect(captured?.currentUserMessageId?.length).toBeGreaterThan(0);
    },
  );
});
