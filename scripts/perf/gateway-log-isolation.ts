// Run after build:runtime: node --import ./scripts/tsx.mjs scripts/perf/gateway-log-isolation.ts
// Two real Gateway processes, no provider calls or operator state.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createOpenClawTestInstance } from "../../test/helpers/openclaw-test-instance.js";
import { runQaGatewayFixture } from "../../test/helpers/qa-gateway-cleanup.js";

const production = await createOpenClawTestInstance({
  name: "log-production",
  config: { plugins: { enabled: false } },
  env: { VITEST: undefined, OPENCLAW_PROFILE: undefined },
});
await runQaGatewayFixture(
  async () => {
    const harness = await createOpenClawTestInstance({
      name: "log-test-harness",
      config: { plugins: { enabled: false } },
      env: { OPENCLAW_PROFILE: undefined },
    });
    await runQaGatewayFixture(
      async () => {
        await production.startGateway();
        await harness.startGateway();
        const files: string[] = [];
        for (const instance of [production, harness]) {
          const result = await instance.cli(["logs", "--json", "--limit", "500"]);
          assert.equal(result.code, 0, result.stderr);
          const events: Array<{ type: string; file?: string }> = result.stdout
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line));
          const file = events.find((event) => event.type === "meta")?.file;
          assert(file, "openclaw logs must report its active file");
          assert(file.startsWith(`${instance.stateDir}${path.sep}`), file);
          const contents = await fs.readFile(file, "utf8");
          assert(contents.includes(`log file: ${file}`), "Missing own startup record");
          const other = instance === production ? harness : production;
          assert(!contents.includes(other.stateDir), "Sibling Gateway contaminated logs");
          files.push(file);
          console.log(
            JSON.stringify({
              name: instance.name,
              file,
              port: instance.port,
              cliExit: result.code,
              ownStartup: true,
              siblingStartup: false,
            }),
          );
        }
        assert.notEqual(files[0], files[1]);
      },
      () => harness.cleanup(),
    );
  },
  () => production.cleanup(),
);
