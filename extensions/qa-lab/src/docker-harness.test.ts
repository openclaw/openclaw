import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runInNewContext } from "node:vm";
import * as processRuntime from "openclaw/plugin-sdk/process-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import YAML from "yaml";
import { buildQaDockerHarnessImage, writeQaDockerHarnessFiles } from "./docker-harness.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  vi.restoreAllMocks();
});
async function scaffold(options: Partial<Parameters<typeof writeQaDockerHarnessFiles>[0]> = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "qa-docker-"));
  roots.push(root);
  const outputDir = path.join(root, "scaffold");
  const repoRoot = path.join(root, "repo #hash");
  await mkdir(repoRoot);
  const result = await writeQaDockerHarnessFiles({
    outputDir,
    repoRoot,
    gatewayToken: "qa-token",
    bindUiDist: true,
    ...options,
  });
  const read = (file: string) => readFile(path.join(outputDir, file), "utf8");
  const compose = await read("docker-compose.qa.yml");
  const services = (
    YAML.parse(compose) as {
      services: Record<
        string,
        {
          build?: { context?: string };
          healthcheck?: { test?: string[] };
          environment?: Record<string, string>;
          volumes?: string[];
        }
      >;
    }
  ).services;
  return { result, compose, services, read, outputDir };
}
function contains(text: string, snippets: string[]) {
  for (const snippet of snippets) {
    expect(text).toContain(snippet);
  }
}

describe("qa docker harness", () => {
  it("writes compose, env, config, and workspace scaffold files", async () => {
    const { result, compose, services, read, outputDir } = await scaffold({
      gatewayPort: 18889,
      qaLabPort: 43124,
      providerBaseUrl: "http://host.docker.internal:45123/v1",
      usePrebuiltImage: true,
    });

    for (const file of [
      ".env.example",
      "README.md",
      "docker-compose.qa.yml",
      "state/openclaw.json",
      ...["QA_KICKOFF_TASK.md", "QA_SCENARIO_PLAN.md", "QA_SCENARIOS.yaml", "IDENTITY.md"].map(
        (name) => `state/seed-workspace/${name}`,
      ),
    ]) {
      expect(result.files).toContain(path.join(outputDir, file));
    }

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
    const healthcheck = services["openclaw-qa-gateway"]?.healthcheck?.test;
    expect(healthcheck?.slice(0, 3)).toEqual(["CMD", "node", "-e"]);
    const healthcheckScript = healthcheck?.[3];
    if (!healthcheckScript) {
      throw new Error("Gateway healthcheck script was not generated");
    }
    for (const outcome of ["ok", "http-error", "network-error"] as const) {
      const events: string[] = [];
      const fetch = vi.fn(async () => {
        if (outcome === "network-error") {
          throw new Error("connection refused");
        }
        return {
          ok: outcome === "ok",
          body: {
            cancel: async () => {
              await Promise.resolve();
              events.push("body-cancelled");
            },
          },
        };
      });
      await runInNewContext(healthcheckScript, {
        fetch,
        process: {
          set exitCode(code: number) {
            events.push("status:" + code);
          },
        },
      });
      expect(fetch).toHaveBeenCalledExactlyOnceWith("http://127.0.0.1:18789/healthz");
      expect(events).toEqual(
        outcome === "network-error"
          ? ["status:1"]
          : ["body-cancelled", outcome === "ok" ? "status:0" : "status:1"],
      );
    }
    expect(compose).toContain("--control-ui-proxy-target http://openclaw-qa-gateway:18789/");
    expect(compose).not.toContain("--control-ui-token");
    expect(compose).not.toContain("qa-token");
    contains(compose, [
      "image: openclaw:qa-local-prebaked",

      '      - "127.0.0.1:18889:18789"',
      '      - "127.0.0.1:43124:43123"',
      "      - sh",
      "      - -lc",

      "--send-kickoff-on-start",
      "--ui-dist-dir /opt/openclaw-qa-lab-ui",
      "cp -R /opt/openclaw-scaffold/seed-workspace/. /tmp/openclaw/workspace/ && rm -rf /tmp/openclaw/workspace/repo && ln -s /opt/openclaw-repo /tmp/openclaw/workspace/repo",
      "OPENCLAW_CONFIG_PATH: /tmp/openclaw/openclaw.json",
      "OPENCLAW_STATE_DIR: /tmp/openclaw/state",
      'OPENCLAW_NO_RESPAWN: "1"',
    ]);

    const envExample = await read(".env.example");
    contains(envExample, [
      "OPENCLAW_GATEWAY_TOKEN=qa-token",
      "QA_BUS_BASE_URL=http://qa-lab:43123",
      "QA_PROVIDER_BASE_URL=http://host.docker.internal:45123/v1",
      "QA_LAB_URL=http://127.0.0.1:43124",
    ]);

    const configText = await read("state/openclaw.json");
    const config = JSON.parse(configText) as {
      plugins?: {
        allow?: string[];
        entries?: Record<string, { enabled?: boolean }>;
      };
    };
    expect(configText).not.toContain('"allowInsecureAuth"');
    contains(configText, [
      '"pluginToolsMcpBridge": true',
      '"openClawToolsMcpBridge": true',
      "/app/dist/control-ui",
      "C-3PO QA",
      '"/tmp/openclaw/workspace"',
    ]);
    expect(config.plugins?.allow).toContain("qa-lab");
    expect(config.plugins?.entries?.["qa-lab"]?.enabled).toBe(true);

    const kickoff = await read("state/seed-workspace/QA_KICKOFF_TASK.md");
    expect(kickoff).toContain("Lobster Invaders");

    const scenarios = await read("state/seed-workspace/QA_SCENARIOS.yaml");
    contains(scenarios, ["pack:", "subagent-fanout-synthesis"]);

    const readme = await read("README.md");
    contains(readme, ["in-process restarts inside Docker", "pnpm qa:lab:watch"]);
  });

  it("builds the reusable QA image with bundled QA extensions", async () => {
    const calls: string[] = [];
    vi.spyOn(processRuntime, "runExec").mockImplementation(async (command, args, options) => {
      const cwd = typeof options === "number" ? undefined : options?.cwd;
      calls.push([command, ...args, `@${cwd}`].join(" "));
      return { stdout: "", stderr: "" };
    });
    const result = await buildQaDockerHarnessImage({
      repoRoot: "/repo/openclaw",
      imageName: "openclaw:qa-local-prebaked",
    });

    expect(result.imageName).toBe("openclaw:qa-local-prebaked");
    expect(calls).toEqual([
      "docker build -t openclaw:qa-local-prebaked --build-arg OPENCLAW_EXTENSIONS=acpx qa-channel qa-lab -f Dockerfile . @/repo/openclaw",
    ]);
  });

  it("quotes generated compose paths so shell-sensitive repo paths survive YAML parsing", async () => {
    const { compose, services } = await scaffold({ usePrebuiltImage: false });
    expect(compose).toContain('OPENCLAW_EXTENSIONS: "acpx qa-channel qa-lab"');
    expect(services["qa-mock-openai"]?.build?.context).toBe("../repo #hash");
    expect(services["qa-lab"]?.volumes).toContain(
      "../repo #hash/extensions/qa-lab/web/dist:/opt/openclaw-qa-lab-ui:ro",
    );
    expect(services["qa-lab"]?.volumes).toContain(
      "../repo #hash/taxonomy.yaml:/app/taxonomy.yaml:ro",
    );
    expect(services["openclaw-qa-gateway"]?.volumes).toContain(
      "../repo #hash:/opt/openclaw-repo:ro",
    );
  });
});
