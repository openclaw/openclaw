import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { afterEach, expect, it } from "vitest";
import { startQaBusServer } from "./bus-server.js";
import { createQaBusState } from "./bus-state.js";
import { createQaGatewayChild } from "./gateway-child.js";
import { startQaMockOpenAiServer } from "./providers/mock-openai/server.js";
import { createQaChannelTransport } from "./qa-channel-transport.js";

const PLUGIN_ID = "qa-current-requester-subagent";
const COMPLETION_MARKER = "QA-CURRENT-REQUESTER-COMPLETION-OK";
const conversation = { id: "requester-user", kind: "direct" as const };
const repoRoot = path.resolve(import.meta.dirname, "../../..");
const pluginDir = path.join(
  repoRoot,
  "extensions/qa-lab/test-fixtures/current-requester-subagent-plugin",
);
const cleanups: Array<() => Promise<void>> = [];

function withFixturePlugin({ plugins, ...config }: OpenClawConfig): OpenClawConfig {
  return {
    ...config,
    plugins: {
      ...plugins,
      enabled: true,
      allow: [...new Set([...(plugins?.allow ?? []), PLUGIN_ID])],
      load: { ...plugins?.load, paths: [...new Set([...(plugins?.load?.paths ?? []), pluginDir])] },
      entries: { ...plugins?.entries, [PLUGIN_ID]: { enabled: true } },
    },
  };
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) {
    await cleanup();
  }
});

it("delivers to the captured requester and rejects forged lineage outside hook scope", async () => {
  const state = createQaBusState();
  const outbound = () =>
    state.getSnapshot().messages.filter(({ direction }) => direction === "outbound");
  const transport = createQaChannelTransport(state);
  const bus = await startQaBusServer({ state });
  cleanups.push(() => bus.stop());
  const mock = await startQaMockOpenAiServer();
  cleanups.push(() => mock.stop());
  const owner = createQaGatewayChild();
  cleanups.push(async () => {
    expect((await owner.stop()).errors).toEqual([]);
  });
  const gateway = await owner.start({
    repoRoot,
    useRepoCli: true,
    providerBaseUrl: `${mock.baseUrl}/v1`,
    providerMode: "mock-openai",
    transport,
    transportBaseUrl: bus.baseUrl,
    controlUiEnabled: false,
    mutateConfig: withFixturePlugin,
  });
  await transport.waitReady({ gateway });
  const response = await fetch(`${gateway.baseUrl}/qa/current-requester/outside-hook`, {
    method: "POST",
    headers: { Authorization: `Bearer ${gateway.token}` },
  });
  expect(response.status).toBe(409);
  await expect(response.json()).resolves.toMatchObject({
    ok: false,
    error: expect.stringContaining("requester-bound plugin hook invocation"),
  });
  const waitOptions = { conversation, sinceIndex: outbound().length };
  await transport.sendInbound({
    accountId: "default",
    conversation,
    senderId: conversation.id,
    text: "qa current requester completion",
  });
  const spawn = await transport.waitForOutbound({ ...waitOptions, timeoutMs: 30_000 });
  expect(spawn.text).toContain("QA-CURRENT-REQUESTER-SPAWNED");
  const completion = await transport.waitForOutbound({
    ...waitOptions,
    textIncludes: COMPLETION_MARKER,
    timeoutMs: 90_000,
  });
  expect(completion.accountId).toBe("default");
  expect(outbound().some((message) => message.conversation.id === "attacker")).toBe(false);
  expect(outbound().filter((message) => message.text.includes(COMPLETION_MARKER))).toHaveLength(1);
}, 180_000);
