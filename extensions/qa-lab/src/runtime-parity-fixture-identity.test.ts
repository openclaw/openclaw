import fs from "node:fs/promises";
import path from "node:path";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { describe, expect, it } from "vitest";
import { createQaBusState } from "./bus-state.js";
import { createQaChannelTransport } from "./qa-channel-transport.js";
import { createParitySessionFixture } from "./runtime-parity-session.test-support.js";
import { captureRuntimeParityCell } from "./runtime-parity.js";
import { readQaScenarioById } from "./scenario-catalog.js";
import { runQaSuiteScenarioDefinition } from "./suite-runtime-flow.js";
import type { QaSuiteRuntimeEnv } from "./suite-runtime-types.js";

const seedSession = createParitySessionFixture();

describe("runtime fixture failure identity", () => {
  it("captures fixture evidence after normal failure redaction and result serialization", async () => {
    const tempRoot = await seedSession({
      sessionId: "unrelated",
      sessionKey: "agent:qa:unrelated",
      updatedAt: 10_000,
      messages: [{ role: "assistant", content: "UNRELATED-EVIDENCE" }],
    });
    const workspaceDir = path.join(tempRoot, "workspace");
    await fs.mkdir(workspaceDir);
    const secret = "synthetic-credential-that-must-not-appear";
    let created = 0;
    const env: QaSuiteRuntimeEnv = {
      outputDir: tempRoot,
      repoRoot: process.cwd(),
      providerMode: "mock-openai",
      primaryModel: "openai/fixture-model",
      alternateModel: "openai/fixture-model",
      mock: null,
      cfg: {},
      transport: createQaChannelTransport(createQaBusState()),
      gateway: {
        baseUrl: "http://127.0.0.1:1",
        tempRoot,
        workspaceDir,
        runtimeEnv: {},
        call: async (method, params) => {
          if (method === "sessions.create") {
            if (!isRecord(params) || typeof params.key !== "string") {
              throw new Error("Expected canonical fixture session key");
            }
            const key = params.key;
            const phase = ++created === 1 ? "happy" : "failure";
            await seedSession({
              tempRoot,
              sessionId: phase,
              sessionKey: key,
              messages: [
                { role: "user", content: `FIXTURE-${phase}` },
                {
                  role: "assistant",
                  content: [
                    { type: "toolCall", id: phase, name: "ls", arguments: { path: phase } },
                  ],
                  usage: { input: 3, output: 2, totalTokens: 5 },
                },
                {
                  role: "toolResult",
                  toolCallId: phase,
                  toolName: "ls",
                  content: [{ type: "text", text: `RESULT-${phase}` }],
                },
              ],
            });
            return { key };
          }
          if (method === "tools.effective") {
            return { groups: [{ tools: [{ id: "ls" }] }] };
          }
          if (method === "agent") {
            return { runId: "fixture-run" };
          }
          if (method === "agent.wait") {
            return { status: "error", error: `fixture execution failed: api_key=${secret}` };
          }
          throw new Error(`Unexpected Gateway method: ${method}`);
        },
      },
    };

    // Exercise the shipped scenario and real fixture/formatter, not a synthetic result.
    const result = await runQaSuiteScenarioDefinition({
      env: { ...env, lab: undefined, webSessionIds: new Set() },
      scenario: readQaScenarioById("runtime-tool-fs-list"),
      constants: {
        imageUnderstandingPngBase64: "",
        imageUnderstandingLargePngBase64: "",
        imageUnderstandingValidPngBase64: "",
      },
    });
    expect(result.status).toBe("fail");
    expect(result.details).toContain("fixture execution failed");
    expect(result.details).not.toContain(secret);
    expect(result.steps[0]?.details).not.toContain(secret);

    // Evidence occurrences are JSON-backed; identity must survive that boundary.
    const cell = await captureRuntimeParityCell({
      runtime: "codex",
      gateway: env.gateway,
      // oxlint-disable-next-line unicorn/prefer-structured-clone -- Exercise the persisted JSON boundary, not an in-memory clone.
      scenarioResult: JSON.parse(JSON.stringify(result)),
      wallClockMs: 10,
    });
    expect(cell.transcriptBytes).toContain("FIXTURE-happy");
    expect(cell.transcriptBytes).toContain("FIXTURE-failure");
    expect(cell.transcriptBytes).not.toContain("UNRELATED-EVIDENCE");
    expect(cell.toolCalls).toEqual([
      expect.objectContaining({ tool: "ls", resultHash: expect.any(String) }),
      expect.objectContaining({ tool: "ls", resultHash: expect.any(String) }),
    ]);
    expect(cell.toolCalls.every((call) => call.resultHash.length > 0)).toBe(true);
    expect(cell.usage).toMatchObject({ inputTokens: 6, outputTokens: 4, totalTokens: 10 });
    expect(cell.runtimeErrorClass).toBe("scenario-failure");
  });
});
