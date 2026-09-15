// Real-transport proof for the header-only rate-limit failover (#143274/#148558).
//
// Nothing that decides the outcome here is mocked: two loopback HTTP servers
// stand in for the provider endpoints, the attempt runs through the real
// openai-responses transport, and the retry cap is read from a real
// settings.json by the settings manager (attempt.ts extraction).
//
// The run is driven through `runWithModelFallback`, the layer that actually owns
// the candidate chain (run-entry.ts wraps the same function for production
// auto-reply and command runs). Calling `runEmbeddedAgent` directly bypasses
// that layer, which is why an earlier version of this test never reached the
// fallback candidate.
//
// Primary answers a 429 whose text carries no usage-window keyword, with the
// reset only in a Retry-After header far above the operator's cap. Before the
// fix the floor was slept in-turn (the run's own timeout killed the turn and the
// fallback never ran); with it the run declines the wait and completes on the
// fallback.
import { once } from "node:events";
import fs from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { disposeOpenClawAgentDatabaseByPath } from "../state/openclaw-agent-db.js";
import { prepareSystemAgentRunAdmission } from "./admitted-run-context.js";
import { runEmbeddedAgent } from "./embedded-agent-runner.js";
import { runWithModelFallback } from "./model-fallback-runner.js";

type RunResult = Awaited<ReturnType<typeof runEmbeddedAgent>>;

const servers = new Set<Server>();
const roots = new Set<string>();

afterEach(async () => {
  await Promise.all(
    Array.from(servers, async (server) => {
      server.closeAllConnections();
      server.close();
      await once(server, "close");
      servers.delete(server);
    }),
  );
  await Promise.all(
    Array.from(roots, async (root) => {
      const storePath = path.join(root, "agents", "main", "agent", "openclaw-agent.sqlite");
      disposeOpenClawAgentDatabaseByPath(storePath);
      await fs.rm(root, { recursive: true, force: true });
      roots.delete(root);
    }),
  );
});

async function listen(server: Server): Promise<number> {
  servers.add(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return (server.address() as AddressInfo).port;
}

// A complete openai-responses SSE turn that yields the text "ok".
function sseCompletion(modelId: string): string {
  const frame = (type: string, response: unknown) =>
    `event: ${type}\ndata: ${JSON.stringify({ type, response })}\n\n`;
  return (
    frame("response.created", { id: "fixture" }) +
    frame("response.completed", {
      id: "fixture",
      model: modelId,
      status: "completed",
      usage: { input_tokens: 1, output_tokens: 1 },
      output: [
        {
          id: "message-fixture",
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: "ok", annotations: [] }],
        },
      ],
    })
  );
}

function providerConfig(baseUrl: string, modelId: string) {
  return {
    api: "openai-responses" as const,
    auth: "api-key" as const,
    apiKey: "***",
    baseUrl,
    models: [
      {
        id: modelId,
        name: modelId,
        reasoning: false,
        input: ["text" as const],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 16_000,
        maxTokens: 1_024,
      },
    ],
  };
}

function payloadText(payloads: Array<{ text?: string } | undefined> | undefined): string {
  return (
    payloads
      ?.map((payload) => payload?.text?.trim())
      .filter((text): text is string => Boolean(text))
      .join(" ") ?? ""
  );
}

describe("retry-after failover through the model fallback layer (real transport)", () => {
  it("fails over a header-only multi-hour 429 to the fallback and completes instead of sleeping the floor", async () => {
    let primaryHits = 0;
    let fallbackHits = 0;

    // Primary: 429 whose body matches no weekly/usage/quota wording, reset carried
    // only in Retry-After, far above the 30s cap below.
    const primaryPort = await listen(
      createServer((request, response) => {
        primaryHits += 1;
        request.resume();
        request.once("end", () => {
          response.writeHead(429, {
            "content-type": "application/json",
            "retry-after": "9897",
          });
          response.end(
            JSON.stringify({
              error: {
                message: "Too Many Requests. Please try again later.",
                type: "rate_limit_error",
              },
            }),
          );
        });
      }),
    );

    // Fallback: an ordinary successful completion.
    const fallbackPort = await listen(
      createServer((request, response) => {
        fallbackHits += 1;
        request.resume();
        request.once("end", () => {
          response.writeHead(200, {
            "content-type": "text/event-stream",
            "cache-control": "no-cache",
          });
          response.end(sseCompletion("mock-2"));
        });
      }),
    );

    const rootDir = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-retryafter-")),
    );
    roots.add(rootDir);
    const agentDir = path.join(rootDir, "agents", "main", "agent");
    const workspaceDir = path.join(rootDir, "workspace");
    await fs.mkdir(agentDir, { recursive: true });
    await fs.mkdir(workspaceDir, { recursive: true });

    // The operator's cap lands in the agent's global settings.json, exactly where
    // the settings manager reads it and attempt.ts attaches it to the attempt.
    await fs.writeFile(
      path.join(agentDir, "settings.json"),
      JSON.stringify({ retry: { provider: { maxRetries: 3, maxRetryDelayMs: 30_000 } } }, null, 2),
    );

    const config: OpenClawConfig = {
      models: {
        providers: {
          openai: providerConfig(`http://127.0.0.1:${primaryPort}/v1`, "mock-1"),
          groq: providerConfig(`http://127.0.0.1:${fallbackPort}/v1`, "mock-2"),
        },
      },
      agents: {
        defaults: { model: { primary: "openai/mock-1", fallbacks: ["groq/mock-2"] } },
        list: [{ id: "main" }],
      },
    };

    const runId = "retry-after-failover-real-transport";
    const sessionId = runId;
    const preparedRunAdmission = prepareSystemAgentRunAdmission(
      config,
      runId,
      "main",
      "integration",
    );
    const outcome = await runWithModelFallback<RunResult>({
      cfg: config,
      agentId: "main",
      agentDir,
      provider: "openai",
      model: "mock-1",
      runId,
      sessionId,
      run: async (provider, model) =>
        runEmbeddedAgent({
          preparedRunAdmission,
          sessionId,
          sessionTarget: {
            agentId: "main",
            sessionId,
            sessionKey: `agent:main:integration:${sessionId}`,
            storePath: path.join(agentDir, "openclaw-agent.sqlite"),
          },
          workspaceDir,
          agentDir,
          config,
          prompt: "Reply with exactly ok.",
          provider,
          model,
          // Bound the attempt well under the 9897s floor: if the fix regressed and
          // the runner slept the floor, this attempt would abort here and the
          // fallback would never serve an answer.
          timeoutMs: 30_000,
          runId,
          disableTools: true,
        }),
    });

    const text = payloadText(outcome.result.payloads);

    // The turn completed on the fallback rather than ending on the primary's 429.
    expect(outcome.outcome).toBe("completed");
    expect(text.toLowerCase()).toContain("ok");
    expect(outcome.provider).toBe("groq");
    expect(outcome.model).toBe("mock-2");
    // The primary was tried once and its floor declined, not retried or slept.
    expect(primaryHits).toBe(1);
    expect(fallbackHits).toBeGreaterThanOrEqual(1);
  }, 900_000);
});
