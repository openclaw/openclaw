import { execFileSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
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
    it("validates pipeline input before accepting its saved resume", async () => {
      profile.value = value;
      const cwd = tempDirs.make("lobster-validation-");
      vi.stubEnv("LOBSTER_STATE_DIR", path.join(cwd, "state"));
      const runner = createEmbeddedLobsterRunner();
      const defaults = { cwd, timeoutMs: 5000, maxStdoutBytes: 32768 };
      const input = await runner.run({
        ...defaults,
        action: "run",
        pipeline: `ask --prompt Question --schema '${JSON.stringify(schema)}'`,
      });
      expect(input.status).toBe("needs_input");
      const token = input.requiresInput?.resumeToken;
      expect(token).toBeTruthy();
      await expect(
        runner.run({ ...defaults, action: "resume", token, responseJson: '{"answer":0}' }),
      ).rejects.toThrow(/schema validation/);
      await expect(
        runner.run({ ...defaults, action: "resume", token, responseJson: '{"answer":2}' }),
      ).resolves.toMatchObject({ status: "ok", output: [{ answer: 2 }] });
    });

    it("retains registered LLM schemas across runner recreation and clears failed results", async () => {
      profile.value = value;
      const cwd = tempDirs.make("lobster-llm-validation-");
      let data = { answer: 2 };
      const server = createServer((request, response) => {
        request.resume();
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ ok: true, result: { output: { data } } }));
      });
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("LLM fixture did not bind its loopback port");
      }
      vi.stubEnv("LOBSTER_STATE_DIR", path.join(cwd, "state"));
      vi.stubEnv("LOBSTER_LLM_ADAPTER_URL", `http://127.0.0.1:${address.port}`);
      vi.stubEnv("LOBSTER_LLM_ADAPTER_TOKEN", "");
      vi.stubEnv("LOBSTER_LLM_MODEL", "test-model");
      vi.stubEnv("LOBSTER_RUN_STATE_KEY", "");
      vi.stubEnv("LOBSTER_LLM_SCHEMA_VERSION", "test");
      const id = `https://example.test/runner/${value}`;
      const run = (outputSchema: Record<string, unknown>) =>
        createEmbeddedLobsterRunner().run({
          cwd,
          timeoutMs: 5000,
          maxStdoutBytes: 32768,
          action: "run",
          pipeline: `llm.invoke --provider http --prompt test --disable-cache true --max-validation-retries 0 --output-schema '${JSON.stringify(outputSchema)}'`,
        });
      try {
        await expect(run({ ...schema, $id: id })).resolves.toMatchObject({ status: "ok" });
        data = { answer: 0 };
        await expect(run({ $ref: id })).rejects.toThrow(/output failed schema validation/);
        data = { answer: 3 };
        await expect(run({ $ref: id })).resolves.toMatchObject({
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

    it("validates workflow input and rejects unsupported schema dialects", async () => {
      profile.value = value;
      const cwd = tempDirs.make("lobster-workflow-validation-");
      vi.stubEnv("LOBSTER_STATE_DIR", path.join(cwd, "state"));
      const runner = createEmbeddedLobsterRunner();
      const defaults = { cwd, timeoutMs: 5000, maxStdoutBytes: 32768 };
      const workflow = path.join(cwd, "workflow.json");
      await fs.writeFile(
        workflow,
        JSON.stringify({
          steps: [{ id: "question", input: { prompt: "Question", responseSchema: schema } }],
        }),
      );
      const input = await runner.run({ ...defaults, action: "run", pipeline: workflow });
      expect(input.status).toBe("needs_input");
      const token = input.requiresInput?.resumeToken;
      expect(token).toBeTruthy();
      await expect(
        runner.run({ ...defaults, action: "resume", token, responseJson: '{"answer":"wrong"}' }),
      ).rejects.toThrow(/schema validation/);
      await expect(
        runner.run({ ...defaults, action: "resume", token, responseJson: '{"answer":3}' }),
      ).resolves.toMatchObject({ status: "ok" });
      for (const malformed of [
        { enum: [] },
        { required: ["x", "x"] },
        { type: "bad" },
        { $schema: "https://example.test/schema" },
      ]) {
        await expect(
          runner.run({
            ...defaults,
            action: "run",
            pipeline: `ask --schema '${JSON.stringify(malformed)}'`,
          }),
        ).rejects.toThrow(/schema is invalid/);
      }
    });
  });
}
