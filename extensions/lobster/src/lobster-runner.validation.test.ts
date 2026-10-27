import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listenOnLoopback } from "../../test-support/hanging-loopback-server.js";
import { createEmbeddedLobsterRunner } from "./lobster-runner.js";

const profile = vi.hoisted(() => ({ value: "dynamic-execution" }));
vi.mock("openclaw/plugin-sdk/runtime-profile", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/runtime-profile")>()),
  getRuntimeExecutionProfile: () => profile.value,
}));
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.unstubAllEnvs());

it("validates fixed contracts and Unicode lengths without runtime code generation", () => {
  const core = createRequire(import.meta.url).resolve("@clawdbot/lobster/core");
  execFileSync(
    process.execPath,
    [
      "--disallow-code-generation-from-strings",
      "--input-type=module",
      "--eval",
      `await import(process.argv[1]);
       const { strict: assert } = await import('node:assert');
       const { validatePayload } = await import(new URL('../commands/stdlib/llm_invoke_validators.generated.js', process.argv[1]));
       const payload = { prompt: '🦞', artifacts: [], artifactHashes: ['🦞'.repeat(10)] };
       assert.equal(validatePayload(payload), true);
       assert.equal(validatePayload({ ...payload, artifactHashes: ['🦞'.repeat(9)] }), false);
       assert.equal(validatePayload({ ...payload, prompt: '' }), false);`,
      pathToFileURL(core).href,
    ],
    { encoding: "utf8" },
  );
});

const schema = {
  type: "object",
  properties: { answer: { type: "integer", minimum: 1 } },
  required: ["answer"],
  additionalProperties: false,
};

for (const value of ["dynamic-execution", "embedded-aot"]) {
  describe(`Lobster schema validation (${value})`, () => {
    let cwd: string;
    let runner: ReturnType<typeof createEmbeddedLobsterRunner>;
    const run = (params: Parameters<typeof runner.run>[0]) => runner.run(params);
    const defaults = () => ({ cwd, timeoutMs: 5000, maxStdoutBytes: 32768 });
    beforeEach(() => {
      profile.value = value;
      cwd = tempDirs.make("lobster-validation-");
      vi.stubEnv("LOBSTER_STATE_DIR", path.join(cwd, "state"));
      runner = createEmbeddedLobsterRunner();
    });

    it.each(["pipeline", "workflow"])(
      "validates %s input before accepting its saved resume",
      async (kind) => {
        let pipeline = `ask --prompt Question --schema '${JSON.stringify(schema)}'`;
        if (kind === "workflow") {
          pipeline = path.join(cwd, "workflow.json");
          await fs.writeFile(
            pipeline,
            JSON.stringify({
              steps: [{ id: "question", input: { prompt: "Question", responseSchema: schema } }],
            }),
          );
        }
        const input = await run({ ...defaults(), action: "run", pipeline });
        expect(input.status).toBe("needs_input");
        const token = input.requiresInput?.resumeToken;
        expect(token).toBeTruthy();
        const resume = (responseJson: string) =>
          run({ ...defaults(), action: "resume", token, responseJson });
        await expect(
          resume(kind === "pipeline" ? '{"answer":0}' : '{"answer":"wrong"}'),
        ).rejects.toThrow(/schema validation/);
        await expect(resume('{"answer":2}')).resolves.toMatchObject({
          status: "ok",
          output: [{ answer: 2 }],
        });
        if (kind === "workflow") {
          for (const malformed of [
            { enum: [] },
            { required: ["x", "x"] },
            { type: "bad" },
            { $schema: "https://example.test/schema" },
          ]) {
            await expect(
              run({
                ...defaults(),
                action: "run",
                pipeline: `ask --schema '${JSON.stringify(malformed)}'`,
              }),
            ).rejects.toThrow(/schema is invalid/);
          }
        }
      },
    );

    it("retains registered LLM schemas across runner recreation and clears failed results", async () => {
      let data = { answer: 2 };
      const server = createServer((request, response) => {
        request.resume();
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ ok: true, result: { output: { data } } }));
      });
      const port = await listenOnLoopback(server);
      vi.stubEnv("LOBSTER_LLM_ADAPTER_URL", `http://127.0.0.1:${port}`);
      vi.stubEnv("LOBSTER_LLM_ADAPTER_TOKEN", "");
      vi.stubEnv("LOBSTER_LLM_MODEL", "test-model");
      vi.stubEnv("LOBSTER_RUN_STATE_KEY", "");
      vi.stubEnv("LOBSTER_LLM_SCHEMA_VERSION", "test");
      const id = `https://example.test/runner/${value}`;
      const invoke = (outputSchema: Record<string, unknown>) =>
        createEmbeddedLobsterRunner().run({
          ...defaults(),
          action: "run",
          pipeline: `llm.invoke --provider http --prompt test --disable-cache true --max-validation-retries 0 --output-schema '${JSON.stringify(outputSchema)}'`,
        });
      try {
        await expect(invoke({ ...schema, $id: id })).resolves.toMatchObject({ status: "ok" });
        data = { answer: 0 };
        await expect(invoke({ $ref: id })).rejects.toThrow(/output failed schema validation/);
        data = { answer: 3 };
        await expect(invoke({ $ref: id })).resolves.toMatchObject({
          status: "ok",
          output: [{ output: { data: { answer: 3 } } }],
        });
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
      }
    });
  });
}
