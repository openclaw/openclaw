import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import OpenAI from "openai";
import type { AgentHarnessAttemptParamsV2 } from "openclaw/plugin-sdk/agent-harness-runtime";
import { saveMediaBuffer } from "openclaw/plugin-sdk/media-store";
import type { OpenClawConfig } from "openclaw/plugin-sdk/plugin-entry";
import {
  createPluginStateKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { createAgentHarnessHostCapabilitiesForTest } from "openclaw/plugin-sdk/plugin-test-runtime";
import { clearRuntimeConfigSnapshot } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { withOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type { AgentsApiBinding } from "./agentsapi-bindings.js";
import {
  createAttempt,
  registerHarness,
  reopenState,
} from "./agentsapi-harness.persistence.test-helpers.js";
import { createModel } from "./agentsapi.test-support.js";

const live = process.env.OPENCLAW_LIVE_TEST === "1" && process.env.OPENCLAW_LIVE_AGENTSAPI === "1";
const describeLive = live ? describe : describe.skip;

afterEach(() => {
  clearRuntimeConfigSnapshot();
  resetPluginStateStoreForTests();
});

// Real registered harness, native session lifecycle, SQLite, attachments, and provider I/O.
// The synthetic host capability is a trap: isolation must not construct Gateway tools.
describeLive("Agents API isolated hosted execution", () => {
  it("runs native code and transfers files without Gateway or MCP capabilities", async () => {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error("OPENAI_API_KEY is required for the Agents API live proof");
    }
    const modelId = process.env.OPENCLAW_LIVE_AGENTSAPI_MODEL?.trim() || "gpt-5.4";
    const client = new OpenAI({ apiKey, baseURL: "https://api.openai.com/v1", maxRetries: 0 });
    await withOpenClawTestState({ label: "agentsapi-isolation-live" }, async (state) => {
      const forwarding = { gatewayTools: false, mcpServers: false };
      const canary = {
        enabled: true,
        transport: "streamable-http" as const,
        url: "https://example.com/never-connect-mcp",
        headers: { Authorization: "Bearer ${OPENCLAW_LIVE_AGENTSAPI_UNSET_CANARY}" },
      };
      const config: OpenClawConfig = {
        plugins: {
          entries: {
            agentsapi: {
              enabled: true,
              config: {
                forwarding,
                nativeTools: [],
                openai_host: { network: { access: "disabled" } },
              },
            },
          },
        },
        mcp: { servers: { "isolation-canary": canary } },
        tools: { web: { search: { enabled: false } } },
      };
      const params = await createAttempt(state.stateDir);
      const construction = vi.fn(async () => {
        throw new Error("Gateway tool construction escaped isolation");
      });
      const model = createModel({
        id: modelId,
        name: modelId,
        reasoning: true,
        contextWindow: 128_000,
        maxTokens: 4096,
      });
      const attempt = {
        ...params,
        config,
        model,
        modelId,
        resolvedApiKey: apiKey,
        timeoutMs: 180_000,
        hostCapabilities: { ...params.hostCapabilities, createToolSurfaceAsync: construction },
      };
      const store = createPluginStateKeyedStoreForTests<AgentsApiBinding>("agentsapi", {
        namespace: "agentsapi-sessions",
        maxEntries: 100_000,
        overflowPolicy: "reject-new",
        env: state.env,
      });
      const harness = registerHarness(state.env, () => config);
      const run = async (input: Pick<AgentHarnessAttemptParamsV2, "prompt" | "media">) => {
        const runId = randomUUID();
        const host = await createAgentHarnessHostCapabilitiesForTest({
          attempt: { ...attempt, ...input, runId },
          pluginId: "agentsapi",
        });
        try {
          return await harness.runAttempt({
            ...attempt,
            ...input,
            runId,
            hostCapabilities: { ...host.capabilities, createToolSurfaceAsync: construction },
          });
        } finally {
          host.close();
        }
      };
      let remoteId: string | undefined;
      onTestFinished(async () => {
        if (!remoteId) {
          return;
        }
        const native = await client.beta.agents.sessions.retrieve(remoteId);
        expect(
          ["idle", "failed"],
          "Unsettled live session retained for recovery: " + remoteId,
        ).toContain(native.status);
        expect((await client.beta.agents.sessions.delete(remoteId)).deleted).toBe(true);
        await expect(client.beta.agents.sessions.retrieve(remoteId)).rejects.toMatchObject({
          status: 404,
        });
      });
      try {
        const marker = randomUUID();
        const inbound = await saveMediaBuffer(
          Buffer.from(JSON.stringify({ marker, value: 42 })),
          "application/json",
          "inbound",
        );
        const first = await run({
          media: [{ url: "media://inbound/" + inbound.id, fileName: "probe.json" }],
          prompt:
            "Use Python through the native shell to read the attached JSON. Write its marker into /workspace/retained-proof.txt. Write /workspace/outputs/proof.json with exactly the JSON keys marker and value, keeping the marker unchanged and doubling the input value. Return the output file and state its numeric result. Do not use the network.",
        });
        expect(first).toHaveProperty("terminal", { kind: "ok" });
        expect(first.agentHarnessId).toBe("agentsapi");
        const binding = await store.lookup(params.sessionId);
        remoteId = binding?.sessionId;
        if (!remoteId) {
          throw new Error("Successful hosted attempt did not persist its native binding");
        }
        const native = await client.beta.agents.sessions.retrieve(remoteId);
        expect(
          native.agent.tools.filter((tool) => tool.type === "mcp" || tool.type === "function"),
        ).toEqual([]);
        if (native.environment.type !== "openai_hosted" || !native.environment.id) {
          throw new Error("Expected an OpenAI-hosted environment identity");
        }
        const environment = await client.beta.agents.environments.retrieve(native.environment.id);
        expect(environment.plugins).toEqual([]);
        expect(environment.skills).toEqual([]);
        const artifacts = await client.beta.agents.sessions.artifacts.list(remoteId);
        const artifact = artifacts.data.find(
          (entry) => entry.path === "/workspace/outputs/proof.json",
        );
        if (!artifact) {
          throw new Error("Hosted output artifact missing");
        }
        const response = await client.beta.agents.sessions.artifacts.content(artifact.id, {
          session_id: remoteId,
        });
        const expected = { marker, value: 84 };
        expect(await response.json()).toEqual(expected);
        const outputs = first.hostOwnedToolMediaUrls ?? [];
        expect(outputs.length).toBeGreaterThan(0);
        expect(
          await Promise.all(
            outputs.map(async (file) => JSON.parse(await fs.readFile(file, "utf8"))),
          ),
        ).toContainEqual(expected);
        const followup = await run({
          prompt:
            "Use the native shell to read /workspace/retained-proof.txt. Do not recreate it. Reply with the exact existing marker only.",
        });
        expect(followup).toHaveProperty("terminal", { kind: "ok" });
        expect(followup.assistantTexts.join("\n")).toContain(marker);
        expect((await store.lookup(params.sessionId))?.sessionId).toBe(remoteId);
        const items = await client.beta.agents.sessions.items.list(remoteId, { limit: 30 });
        expect(
          items.data.filter((item) => item.type === "command_execution" && item.exit_code === 0)
            .length,
        ).toBeGreaterThanOrEqual(2);
        expect(construction).not.toHaveBeenCalled();
        // Even a change with no current MCP declarations must not reuse an old policy binding.
        forwarding.mcpServers = true;
        canary.enabled = false;
        const changed = await run({
          prompt: "This turn must require a reset.",
        });
        expect(changed).toMatchObject({ terminal: { kind: "failed" } });
        expect((await store.lookup(params.sessionId))?.sessionId).toBe(remoteId);
        await harness.reset({ ...params.sessionTarget, reason: "reset" });
        expect((await store.lookup(params.sessionId))?.sessionId).toBeUndefined();
      } finally {
        remoteId ??= (await store.lookup(params.sessionId))?.sessionId;
        await harness.dispose();
        await reopenState();
      }
    });
  }, 360_000);
});
