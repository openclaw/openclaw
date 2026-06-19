// Qa Lab tests cover docker harness plugin behavior.
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import YAML from "yaml";
import { buildQaDockerHarnessImage, writeQaDockerHarnessFiles } from "./docker-harness.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
});

function parseComposeServices(compose: string) {
  const parsed = YAML.parse(compose) as {
    services?: Record<
      string,
      {
        environment?: Record<string, string>;
        volumes?: string[];
      }
    >;
  };
  return parsed.services ?? {};
}

describe("qa docker harness", () => {
  it("writes compose, env, config, and workspace scaffold files", async () => {
    const outputDir = await mkdtemp(path.join(os.tmpdir(), "qa-docker-test-"));
    cleanups.push(async () => {
      await rm(outputDir, { recursive: true, force: true });
    });

    const result = await writeQaDockerHarnessFiles({
      outputDir,
      gatewayPort: 18889,
      qaLabPort: 43124,
      gatewayToken: "qa-token",
      providerBaseUrl: "http://host.docker.internal:45123/v1",
      repoRoot: "/repo/openclaw",
      usePrebuiltImage: true,
      bindUiDist: true,
    });

    for (const expectedFile of [
      path.join(outputDir, ".env.example"),
      path.join(outputDir, "README.md"),
      path.join(outputDir, "docker-compose.qa.yml"),
      path.join(outputDir, "state", "openclaw.json"),
      path.join(outputDir, "state", "seed-workspace", "QA_KICKOFF_TASK.md"),
      path.join(outputDir, "state", "seed-workspace", "QA_SCENARIO_PLAN.md"),
      path.join(outputDir, "state", "seed-workspace", "QA_SCENARIOS.yaml"),
      path.join(outputDir, "state", "seed-workspace", "IDENTITY.md"),
    ]) {
      expect(result.files).toContain(expectedFile);
    }

    const compose = await readFile(path.join(outputDir, "docker-compose.qa.yml"), "utf8");
    const services = parseComposeServices(compose);
    expect(compose).toContain("image: openclaw:qa-local-prebaked");
    expect(compose).toContain("qa-mock-openai:");
    expect(services["qa-mock-openai"]?.environment).toMatchObject({
      OPENCLAW_ENABLE_PRIVATE_QA_CLI: "1",
      OPENCLAW_PROFILE: "",
    });
    expect(services["qa-mock-openai"]?.environment).not.toHaveProperty("OPENCLAW_CONFIG_PATH");
    expect(services["qa-mock-openai"]?.volumes).toBeUndefined();
    expect(services["qa-lab"]?.environment).toMatchObject({
      OPENCLAW_ENABLE_PRIVATE_QA_CLI: "1",
      OPENCLAW_CONFIG_PATH: "/opt/openclaw-scaffold/openclaw.json",
      OPENCLAW_STATE_DIR: "/tmp/openclaw/state",
    });
    expect(services["qa-lab"]?.volumes).toContain("./state:/opt/openclaw-scaffold:ro");
    expect(compose).toContain('      - "127.0.0.1:18889:18789"');
    expect(compose).toContain('      - "127.0.0.1:43124:43123"');
    expect(compose).toContain(":/opt/openclaw-qa-lab-ui:ro");
    expect(compose).toContain("      - sh");
    expect(compose).toContain("      - -lc");
    expect(compose).toContain(
      '        - fetch("http://127.0.0.1:18789/healthz").then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))',
    );
    expect(compose).toContain("--control-ui-proxy-target http://openclaw-qa-gateway:18789/");
    expect(compose).not.toContain("--control-ui-token");
    expect(compose).not.toContain("qa-token");
    expect(compose).toContain("--send-kickoff-on-start");
    expect(compose).toContain("--ui-dist-dir /opt/openclaw-qa-lab-ui");
    expect(compose).toContain(":/opt/openclaw-repo:ro");
    expect(compose).toContain("./state:/opt/openclaw-scaffold:ro");
    expect(compose).toContain(
      "cp -R /opt/openclaw-scaffold/seed-workspace/. /tmp/openclaw/workspace/",
    );
    expect(compose).toContain("OPENCLAW_CONFIG_PATH: /tmp/openclaw/openclaw.json");
    expect(compose).toContain("OPENCLAW_STATE_DIR: /tmp/openclaw/state");
    expect(compose).toContain('OPENCLAW_NO_RESPAWN: "1"');

    const envExample = await readFile(path.join(outputDir, ".env.example"), "utf8");
    expect(envExample).toContain("OPENCLAW_GATEWAY_TOKEN=qa-token");
    expect(envExample).toContain("QA_BUS_BASE_URL=http://qa-lab:43123");
    expect(envExample).toContain("QA_PROVIDER_BASE_URL=http://host.docker.internal:45123/v1");
    expect(envExample).toContain("QA_LAB_URL=http://127.0.0.1:43124");

    const configText = await readFile(path.join(outputDir, "state", "openclaw.json"), "utf8");
    const config = JSON.parse(configText) as {
      plugins?: {
        allow?: string[];
        entries?: Record<string, { enabled?: boolean }>;
      };
    };
    expect(configText).toContain('"allowInsecureAuth": true');
    expect(configText).toContain('"pluginToolsMcpBridge": true');
    expect(configText).toContain('"openClawToolsMcpBridge": true');
    expect(configText).toContain("/app/dist/control-ui");
    expect(configText).toContain("C-3PO QA");
    expect(configText).toContain('"/tmp/openclaw/workspace"');
    expect(config.plugins?.allow).toContain("qa-lab");
    expect(config.plugins?.entries?.["qa-lab"]?.enabled).toBe(true);

    const kickoff = await readFile(
      path.join(outputDir, "state", "seed-workspace", "QA_KICKOFF_TASK.md"),
      "utf8",
    );
    expect(kickoff).toContain("Lobster Invaders");

    const scenarios = await readFile(
      path.join(outputDir, "state", "seed-workspace", "QA_SCENARIOS.yaml"),
      "utf8",
    );
    expect(scenarios).toContain("pack:");
    expect(scenarios).toContain("subagent-fanout-synthesis");

    const readme = await readFile(path.join(outputDir, "README.md"), "utf8");
    expect(readme).toContain("in-process restarts inside Docker");
    expect(readme).toContain("pnpm qa:lab:watch");
  });

  it("builds the reusable QA image with bundled QA extensions", async () => {
    const calls: string[] = [];
    const result = await buildQaDockerHarnessImage(
      {
        repoRoot: "/repo/openclaw",
        imageName: "openclaw:qa-local-prebaked",
      },
      {
        async runCommand(command, args, cwd) {
          calls.push([command, ...args, `@${cwd}`].join(" "));
          return { stdout: "", stderr: "" };
        },
      },
    );

    expect(result.imageName).toBe("openclaw:qa-local-prebaked");
    expect(calls).toEqual([
      "docker build -t openclaw:qa-local-prebaked --build-arg OPENCLAW_EXTENSIONS=qa-channel qa-lab -f Dockerfile . @/repo/openclaw",
    ]);
  });
});
