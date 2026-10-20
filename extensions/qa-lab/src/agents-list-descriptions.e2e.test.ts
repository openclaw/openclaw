import path from "node:path";
import { runQaGatewayFixture, stopQaGatewayFixture } from "openclaw/plugin-sdk/test-env";
import { expect, it } from "vitest";
import { createQaGatewayChild } from "./gateway-child.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");

// Public HTTP discovery proof; no model inference or external delivery is needed by this tool.
it(
  "bounds configured descriptions without changing the authorized Gateway roster",
  { timeout: 180_000 },
  async () => {
    const owner = createQaGatewayChild();
    await runQaGatewayFixture(
      async () => {
        const gateway = await owner.start({
          repoRoot: REPO_ROOT,
          command: {
            executablePath: process.execPath,
            argsPrefix: [path.join(REPO_ROOT, "dist/index.js")],
            cwd: REPO_ROOT,
            usePackagedPlugins: false,
            tempParentDir: process.env.TMPDIR,
          },
          providerBaseUrl: "http://127.0.0.1:9/v1",
          transportBaseUrl: "",
          providerMode: "mock-openai",
          primaryModel: "mock-openai/gpt-5.6-luna",
          alternateModel: "mock-openai/gpt-5.6-luna",
          forcedRuntime: "openclaw",
          runtimeSelection: "configured",
          controlUiEnabled: false,
          runtimeEnvPatch: {
            HTTP_PROXY: "http://127.0.0.1:9",
            HTTPS_PROXY: "http://127.0.0.1:9",
            ALL_PROXY: "http://127.0.0.1:9",
            NO_PROXY: "127.0.0.1,localhost,::1",
          },
          mutateConfig: (config) => ({
            ...config,
            skills: { workshop: { autonomous: { mode: "off" } } },
            tools: { profile: "full", allow: ["agents_list"] },
            agents: {
              ...config.agents,
              ownership: "explicit",
              defaults: { ...config.agents?.defaults, heartbeat: { every: "0m" } },
              entries: {
                qa: {
                  ...config.agents?.entries?.qa,
                  subagents: { allowAgents: ["*"] },
                  tools: { profile: "full", allow: ["agents_list"] },
                },
                "a-unicode": { name: "Unicode", description: `${"a".repeat(511)}🚀tail` },
                ...Object.fromEntries(
                  Array.from({ length: 6 }, (_, index) => [
                    `b-cjk${index}`,
                    { description: "漢".repeat(512) },
                  ]),
                ),
                gate: { subagents: { allowAgents: ["a-unicode", "z-blank"] } },
                "z-blank": { description: "   " },
              },
            },
          }),
        });
        console.log("AGENTS_DESCRIPTION_OWNER " + JSON.stringify({ pid: gateway.pid }));
        const invoke = async (agentId: string) => {
          const response = await fetch(`${gateway.baseUrl}/tools/invoke`, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${gateway.token}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              tool: "agents_list",
              args: {},
              agentId,
              sessionKey: `agent:${agentId}:description-proof`,
            }),
          });
          expect(response.status).toBe(200);
          const body = (await response.json()) as {
            ok: boolean;
            result: {
              details: {
                requester: string;
                agents: Array<{
                  id: string;
                  name?: string;
                  description?: string;
                  model?: string;
                  agentRuntime?: { id: string; source: string };
                }>;
              };
            };
          };
          expect(body.ok).toBe(true);
          expect(body.result.details.requester).toBe(agentId);
          return body.result.details.agents;
        };
        const agents = await invoke("qa");
        const ids = [
          "qa",
          "a-unicode",
          ...Array.from({ length: 6 }, (_, i) => `b-cjk${i}`),
          "gate",
          "z-blank",
        ];
        expect(agents.map(({ id }) => id)).toEqual(ids);
        const description = (id: string) => agents.find((agent) => agent.id === id)?.description;
        expect(description("a-unicode")).toBe(`${"a".repeat(511)}…`);
        expect(description("b-cjk0")).toBe("漢".repeat(512));
        expect(description("b-cjk1")).toBe(`${"漢".repeat(383)}…`);
        for (const id of ["b-cjk2", "b-cjk3", "b-cjk4"]) {
          expect(description(id)).toBe("…");
        }
        for (const id of ["b-cjk5", "gate", "z-blank"]) {
          expect(agents.find((agent) => agent.id === id)).not.toHaveProperty("description");
        }
        const weightedUnits = agents.reduce(
          (sum, agent) =>
            sum +
            Array.from(agent.description ?? "").reduce(
              (total, char) => total + (char === "漢" ? 4 : char.length),
              0,
            ),
          0,
        );
        expect(weightedUnits).toBe(4096);
        expect(
          agents.every(
            (agent) =>
              agent.model === "mock-openai/gpt-5.6-luna" &&
              agent.agentRuntime?.id === "auto" &&
              agent.agentRuntime.source === "implicit",
          ),
        ).toBe(true);
        const restricted = await invoke("gate");
        expect(restricted.map(({ id }) => id)).toEqual(["a-unicode", "z-blank"]);
        expect(restricted[0]).toMatchObject({
          name: "Unicode",
          description: `${"a".repeat(511)}…`,
        });
        expect(restricted[1]).not.toHaveProperty("description");
        console.log(
          "AGENTS_DESCRIPTION_PROOF " +
            JSON.stringify({
              gatewayHttp: true,
              rosterCount: agents.length,
              restrictedCount: restricted.length,
              unicodeUnits: description("a-unicode")?.length,
              aggregateWeightedUnits: weightedUnits,
              modelMetadataRetained: true,
              noInferenceOrExternalDelivery: true,
            }),
        );
      },
      async () => {
        await stopQaGatewayFixture(owner, { label: "agents-description-gateway" });
      },
    );
  },
);
