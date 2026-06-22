import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { withTempDir } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it } from "vitest";

describe("sherpa-onnx-tts plugin skill bin script", () => {
  const cases = [
    {
      name: "OPENCLAW_STATE_DIR before config and home overrides",
      configDir: (root: string) => path.join(root, "state"),
      env: (root: string) => ({
        OPENCLAW_STATE_DIR: path.join(root, "state"),
        OPENCLAW_CONFIG_PATH: path.join(root, "profiles", "dev", "openclaw.json"),
        OPENCLAW_HOME: path.join(root, "home"),
      }),
    },
    {
      name: "the OPENCLAW_CONFIG_PATH directory before the home override",
      configDir: (root: string) => path.join(root, "profiles", "dev"),
      env: (root: string) => ({
        OPENCLAW_CONFIG_PATH: path.join(root, "profiles", "dev", "openclaw.json"),
        OPENCLAW_HOME: path.join(root, "home"),
      }),
    },
    {
      name: "OPENCLAW_HOME when state and config overrides are unset",
      configDir: (root: string) => path.join(root, "home", ".openclaw"),
      env: (root: string) => ({
        OPENCLAW_HOME: path.join(root, "home"),
      }),
    },
  ];

  it.each(cases)("loads as ESM and resolves $name", async ({ configDir, env }) => {
    await withTempDir("openclaw-sherpa-tts-test-", async (root) => {
      const scriptPath = path.resolve(
        process.cwd(),
        "extensions",
        "sherpa-onnx-tts",
        "skills",
        "sherpa-onnx-tts",
        "bin",
        "sherpa-onnx-tts",
      );
      const toolsDir = path.join(configDir(root), "tools", "sherpa-onnx-tts");
      const modelDir = path.join(toolsDir, "models", "vits-piper-en_US-lessac-high");
      mkdirSync(path.join(modelDir, "espeak-ng-data"), { recursive: true });
      writeFileSync(path.join(modelDir, "model.onnx"), "");
      writeFileSync(path.join(modelDir, "tokens.txt"), "");

      const childEnv = {
        ...process.env,
        OPENCLAW_STATE_DIR: "",
        OPENCLAW_CONFIG_PATH: "",
        OPENCLAW_HOME: "",
        SHERPA_ONNX_RUNTIME_DIR: "",
        SHERPA_ONNX_MODEL_DIR: "",
      };
      Object.assign(childEnv, env(root));
      const result = spawnSync(process.execPath, [scriptPath, "hello"], {
        encoding: "utf8",
        env: childEnv,
      });

      expect(result.status).toBe(1);
      const binaryName =
        process.platform === "win32" ? "sherpa-onnx-offline-tts.exe" : "sherpa-onnx-offline-tts";
      const binaryPath = path.join(toolsDir, "runtime", "bin", binaryName);
      expect(result.stderr).toContain(`TTS binary not found: ${binaryPath}`);
    });
  });
});
