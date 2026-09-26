import { execFile } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { promisify } from "node:util";
import { withTempHome } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it } from "vitest";

describe("agent command static capabilities", () => {
  const cases = [
    { inventory: "empty", contextTokens: 1_000_000, thinking: "medium" },
    { inventory: "authored", contextTokens: 640_000, thinking: "off" },
    { inventory: "replace", contextTokens: 1_000_000, thinking: "medium" },
    { inventory: "generic", contextTokens: 200_000, thinking: "off" },
    { inventory: "explicit off", contextTokens: 1_000_000, thinking: "off" },
  ] as const;
  const key = "synthetic-static-capability-key";

  it.each(cases)("uses prepared $inventory capabilities on the first request", async (testCase) => {
    await withTempHome(
      async (home) => {
        const configPath = path.join(home, "openclaw.json");
        const stateDir = path.join(home, "state");
        const requests: Array<{ method?: string; url?: string; auth?: string; model: string }> = [];
        const server = http.createServer((req, res) => {
          const chunks: Buffer[] = [];
          req.on("data", (chunk: Buffer) => {
            chunks.push(chunk);
          });
          req.on("end", () => {
            const body = JSON.parse(Buffer.concat(chunks).toString());
            requests.push({
              method: req.method,
              url: req.url,
              auth: req.headers.authorization,
              model: body.model,
            });
            res.writeHead(200, { "content-type": "text/event-stream" });
            const common = {
              id: "fixture-reply",
              object: "chat.completion.chunk",
              created: 1,
              model: body.model,
            };
            for (const row of [
              {
                ...common,
                choices: [
                  {
                    index: 0,
                    delta: { role: "assistant", content: "STATIC_OK" },
                    finish_reason: null,
                  },
                ],
              },
              {
                ...common,
                choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
                usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
              },
            ]) {
              res.write(`data: ${JSON.stringify(row)}\n\n`);
            }
            res.end("data: [DONE]\n\n");
          });
        });
        server.listen(0, "127.0.0.1");
        await once(server, "listening");
        try {
          const address = server.address();
          if (!address || typeof address === "string") {
            throw new Error("Expected a TCP fixture address");
          }
          const baseUrl = `http://127.0.0.1:${address.port}/proxy/v1`;
          const env = { OPENCLAW_STATE_DIR: stateDir, OPENCLAW_CONFIG_PATH: configPath };
          const primary = "litellm/claude-opus-4-6";
          // LiteLLM onboarding and replace-mode config generation are covered in
          // extensions/litellm/index.test.ts. This integration test needs only the
          // exact config inputs for each isolated first local request.
          const litellmProvider = {
            baseUrl,
            api: "openai-completions",
            apiKey: key,
            models:
              testCase.inventory === "replace"
                ? [
                    {
                      id: "claude-opus-4-6",
                      name: "Claude Opus 4.6",
                      reasoning: true,
                      input: ["text", "image"],
                      contextWindow: 1_000_000,
                      maxTokens: 128_000,
                      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                    },
                  ]
                : ([] as Array<Record<string, unknown>>),
          };
          const providers: Record<string, typeof litellmProvider> = { litellm: litellmProvider };
          const config = {
            agents: {
              defaults: {
                workspace: path.join(home, "workspace"),
                models: { [primary]: { alias: "LiteLLM" } },
                model: { primary },
              },
              entries: {
                main: {
                  name: "main",
                  workspace: path.join(home, "workspace"),
                  agentDir: path.join(stateDir, "agents", "main", "agent"),
                },
              },
            },
            plugins: { entries: { litellm: { enabled: true } } },
            models: {
              mode: testCase.inventory === "replace" ? "replace" : "merge",
              providers,
            },
          };
          if (testCase.inventory === "authored") {
            litellmProvider.models = [
              {
                id: config.agents.defaults.model.primary.slice("litellm/".length),
                name: "Authored fixture",
                reasoning: false,
                input: ["text", "image"],
                contextWindow: 640_000,
                maxTokens: 128_000,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              },
            ];
          } else if (testCase.inventory === "replace") {
            expect(litellmProvider.models).toHaveLength(1);
          } else if (testCase.inventory === "generic") {
            config.models.providers = {
              "proxy-fixture": { baseUrl, api: "openai-completions", apiKey: key, models: [] },
            };
            config.agents.defaults.model.primary = "proxy-fixture/plain-fixture";
          } else {
            litellmProvider.models = [];
          }
          await fs.writeFile(configPath, JSON.stringify(config));
          expect(requests).toEqual([]);
          const { stdout } = await promisify(execFile)(
            process.execPath,
            [
              path.resolve("openclaw.mjs"),
              "agent",
              "--local",
              "--agent",
              "main",
              "--message",
              "Reply with STATIC_OK only.",
              "--json",
              ...(testCase.inventory === "explicit off" ? ["--thinking", "off"] : []),
            ],
            {
              cwd: process.cwd(),
              env: {
                PATH: process.env.PATH,
                HOME: home,
                USERPROFILE: home,
                ...env,
                OPENCLAW_NO_RESPAWN: "1",
              },
              timeout: 60_000,
              maxBuffer: 10 * 1024 * 1024,
            },
          );
          const output = JSON.parse(stdout);
          expect(output.payloads).toEqual([{ text: "STATIC_OK", mediaUrl: null }]);
          expect(output.meta.agentMeta.contextTokens).toBe(testCase.contextTokens);
          expect(output.meta.requestShaping.thinking).toBe(testCase.thinking);
          const selectedPrimary = config.agents.defaults.model.primary;
          expect(requests).toEqual([
            {
              method: "POST",
              url: "/proxy/v1/chat/completions",
              auth: `Bearer ${key}`,
              model: selectedPrimary.slice(selectedPrimary.indexOf("/") + 1),
            },
          ]);
        } finally {
          server.closeAllConnections();
          await new Promise<void>((resolve, reject) => {
            server.close((error) => (error ? reject(error) : resolve()));
          });
        }
      },
      { prefix: "openclaw-static-first-request-" },
    );
  });
});
