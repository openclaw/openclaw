// Opt-in live model selection/compliance proof; no Gateway or external task actions.
// OPENCLAW_LIVE_TEST=1 ANTHROPIC_API_KEY=... pnpm test:live <this-file>
// To compare a pinned baseline, save its system-prompt-skills.ts beside that owner
// and set OPENCLAW_LIVE_SKILLS_BASELINE_MODULE to the saved module's absolute path.
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { Message, Model } from "openclaw/plugin-sdk/llm";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { prepareSkillsForPrompt } from "../skills/loading/skill-prompt-limits.js";
import { createCanonicalFixtureSkill } from "../skills/test-support/test-helpers.js";
import { buildCodeModeCatalogPrompt } from "./code-mode.js";
import { createCatalogCodeModeHarness, resetCodeModeTestState } from "./code-mode.test-support.js";
import { prepareInstalledSkillCatalog } from "./installed-skill-runtime.js";
import { completeSimpleWithLiveTimeout } from "./live-cache-test-support.js";
import { isLiveTestEnabled } from "./live-test-helpers.js";
import { buildSkillsSection } from "./system-prompt-skills.js";
import { buildAgentSystemPrompt } from "./system-prompt.js";
import { jsonResult, type AnyAgentTool } from "./tools/common.js";
import { createInstalledSkillTools } from "./tools/installed-skill-tools.js";

const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
const describeLive = isLiveTestEnabled() && apiKey ? describe : describe.skip;
const baselineModule = process.env.OPENCLAW_LIVE_SKILLS_BASELINE_MODULE;
const variants = baselineModule ? ["baseline", "candidate"] : ["candidate"];
const model: Model<"anthropic-messages"> = {
  id: "claude-opus-5-5",
  name: "Claude Opus 5.5",
  provider: "anthropic",
  api: "anthropic-messages",
  baseUrl: "https://api.anthropic.com",
  reasoning: true,
  input: ["text"],
  contextWindow: 1_000_000,
  maxTokens: 4096,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const cases = [
  {
    name: "task-selected workflow",
    prompt: "Check the synthetic release's update reliability and record the diagnostic result.",
    skill: "release-audit",
    receipt: "RELEASE-CHECK-ORCHID",
  },
  {
    name: "known exact workflow",
    prompt: "Use release-audit to check the synthetic release and record the diagnostic result.",
    skill: "release-audit",
    receipt: "RELEASE-CHECK-ORCHID",
  },
  {
    name: "workflow outside prompt directory",
    prompt: "Investigate the synthetic worker's queue drought and record the diagnostic result.",
    skill: "zeta-queue-drought",
    receipt: "QUEUE-CHECK-COBALT",
  },
  { name: "simple conversation", prompt: "Hi!", skill: undefined, receipt: undefined },
];

afterEach(resetCodeModeTestState);

describeLive("Code Mode skill discovery (live)", () => {
  it.skipIf(!process.env.OPENCLAW_LIVE_SKILLS_MEASUREMENT)(
    "counts reconstructed prompt tokens",
    async () => {
      const measurement: unknown = JSON.parse(
        await readFile(process.env.OPENCLAW_LIVE_SKILLS_MEASUREMENT!, "utf8"),
      );
      if (!isRecord(measurement) || !isRecord(measurement.prompts)) {
        throw new Error("Expected a synthetic measurement with before/after prompts");
      }
      for (const variant of ["before", "after"]) {
        const prompt = measurement.prompts[variant];
        expect(typeof prompt).toBe("string");
        const response = await fetch("https://api.anthropic.com/v1/messages/count_tokens", {
          method: "POST",
          headers: {
            "x-api-key": apiKey!,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            model: model.id,
            system: prompt,
            messages: [{ role: "user", content: "hello" }],
          }),
          signal: AbortSignal.timeout(30_000),
        });
        expect(response.status).toBe(200);
        const body: unknown = await response.json();
        if (!isRecord(body) || typeof body.input_tokens !== "number") {
          throw new Error("Missing input_tokens from token counter");
        }
        console.log(
          JSON.stringify({
            measurement: "synthetic system plus hello; no tool schemas",
            variant,
            inputTokens: body.input_tokens,
          }),
        );
      }
    },
  );
  it.each(cases)(
    "$name",
    async (scenario) => {
      for (const variant of variants) {
        const calls: Array<{ name: string; input: unknown }> = [];
        const skills = [
          ...Array.from({ length: 99 }, (_, index) => ({
            name: `fixture-${String(index).padStart(3, "0")}`,
            description: `Fixture ${index}: instructions for an unrelated synthetic inventory category.`,
            content: "This guide does not cover release updates or queue droughts.",
          })),
          {
            name: "release-audit",
            description: "Check release update reliability and record the diagnostic result.",
            content:
              'Complete this synthetic diagnostic by calling record_check({receipt:"RELEASE-CHECK-ORCHID"}). Then report the accepted result.',
          },
          {
            name: "zeta-queue-drought",
            description: "Investigate worker queue drought and record the diagnostic result.",
            content:
              'Complete this synthetic diagnostic by calling record_check({receipt:"QUEUE-CHECK-COBALT"}). Then report the accepted result.',
          },
        ].map(({ name, description, content }) =>
          Object.assign(
            createCanonicalFixtureSkill({
              name,
              description,
              filePath: `/synthetic/skills/${name}/SKILL.md`,
              baseDir: `/synthetic/skills/${name}`,
              source: "bundled",
            }),
            { readContent: content },
          ),
        );
        const snapshot = {
          prompt: prepareSkillsForPrompt({ skills, maxSkillsInPrompt: 100 }).prompt,
          skills: skills.map(({ name }) => ({ name })),
          discoverySkills: skills,
        };
        const installed = prepareInstalledSkillCatalog({
          snapshot,
          workspaceDir: "/synthetic/loop",
        });
        const record: AnyAgentTool = {
          name: "record_check",
          label: "Record diagnostic",
          description: "Record a completed synthetic diagnostic using its instructed receipt.",
          parameters: Type.Object({ receipt: Type.String() }),
          execute: async () => jsonResult({ accepted: true }),
        };
        const targets = [...createInstalledSkillTools(installed), record];
        for (const tool of targets) {
          const execute = tool.execute;
          tool.execute = async (...args) => {
            calls.push({ name: tool.name, input: args[1] });
            return execute(...args);
          };
        }
        const h = createCatalogCodeModeHarness(targets, { codeModeSkills: installed });
        const sectionParams = {
          skillsPrompt: snapshot.prompt,
          codeModeActive: true,
          readToolName: "read",
          promptSurface: "openclaw_main" as const,
          availableTools: new Set(["exec", "wait", ...targets.map(({ name }) => name)]),
          visibleTools: new Map([
            ["exec", "exec"],
            ["wait", "wait"],
          ]),
        };
        let systemPrompt = buildAgentSystemPrompt({
          workspaceDir: "/synthetic/loop",
          skillsPrompt: snapshot.prompt,
          toolNames: ["exec", "wait"],
          capabilityToolNames: targets.map(({ name }) => name),
          codeModeActive: true,
          includeMemorySection: false,
        });
        if (variant === "baseline" && baselineModule) {
          const baseline: typeof import("./system-prompt-skills.js") = await import(
            pathToFileURL(baselineModule).href
          );
          const current = buildSkillsSection(sectionParams).section.filter(Boolean).join("\n");
          expect(systemPrompt).toContain(current);
          systemPrompt = systemPrompt.replace(
            current,
            baseline.buildSkillsSection(sectionParams).section.filter(Boolean).join("\n"),
          );
        }
        systemPrompt += `\n\n${buildCodeModeCatalogPrompt(h.ctx, h.catalogRef.current?.entries ?? [])}`;
        const messages: Message[] = [{ role: "user", content: scenario.prompt, timestamp: 1 }];
        let firstInputTokens = 0;
        let finished = false;
        for (let round = 0; round < 8; round++) {
          const response = await completeSimpleWithLiveTimeout(
            model,
            { systemPrompt, messages, tools: h.tools },
            { apiKey, cacheRetention: "none", maxTokens: 2048, temperature: 0 },
            `skills ${variant} ${scenario.name}`,
            120_000,
          );
          expect(response.errorMessage, "live provider error").toBeUndefined();
          if (round === 0) {
            firstInputTokens =
              response.usage.input + response.usage.cacheRead + response.usage.cacheWrite;
          }
          messages.push(response);
          const toolCalls = response.content.filter((block) => block.type === "toolCall");
          if (toolCalls.length === 0) {
            finished = true;
            break;
          }
          for (const call of toolCalls) {
            const tool = h.tools.find(({ name }) => name === call.name);
            expect(tool, `unknown tool ${call.name}`).toBeDefined();
            const result = await tool!.execute(call.id, call.arguments);
            messages.push({
              role: "toolResult",
              toolCallId: call.id,
              toolName: call.name,
              content: result.content.filter((part) => part.type === "text"),
              isError: false,
              timestamp: Date.now(),
            });
          }
        }
        console.log(
          JSON.stringify({
            variant,
            scenario: scenario.name,
            systemChars: systemPrompt.length,
            firstInputTokens,
            calls,
            finished,
          }),
        );
        expect(finished).toBe(true);
        if (scenario.skill) {
          const readIndex = calls.findIndex((call) => call.name === "skills_read");
          const actionIndex = calls.findIndex((call) => call.name === "record_check");
          expect(readIndex).toBeGreaterThanOrEqual(0);
          expect(calls[readIndex]).toMatchObject({ input: { name: scenario.skill } });
          expect(actionIndex).toBeGreaterThan(readIndex);
          expect(calls[actionIndex]).toMatchObject({ input: { receipt: scenario.receipt } });
          if (scenario.name === "known exact workflow") {
            expect(calls.some((call) => call.name === "skills_search")).toBe(false);
          } else if (
            variant === "candidate" ||
            scenario.name === "workflow outside prompt directory"
          ) {
            expect(calls.findIndex((call) => call.name === "skills_search")).toBeLessThan(
              readIndex,
            );
            expect(calls.some((call) => call.name === "skills_search")).toBe(true);
          }
        } else {
          expect(calls).toEqual([]);
        }
        await resetCodeModeTestState();
      }
    },
    300_000,
  );
});
