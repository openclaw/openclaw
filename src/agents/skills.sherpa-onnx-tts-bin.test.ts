import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("skills/sherpa-onnx-tts bin script", () => {
  it("loads as ESM and falls through to usage output when env is missing", () => {
    const scriptPath = path.resolve(
      process.cwd(),
      "skills",
      "sherpa-onnx-tts",
      "bin",
      "sherpa-onnx-tts",
    );
    const result = spawnSync(process.execPath, [scriptPath], {
      encoding: "utf8",
      env: {
        ...process.env,
        SHERPA_ONNX_RUNTIME_DIR: "",
        SHERPA_ONNX_MODEL_DIR: "",
        SHERPA_ONNX_MODEL_FILE: "",
        SHERPA_ONNX_TOKENS_FILE: "",
        SHERPA_ONNX_DATA_DIR: "",
      },
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Missing runtime/model directory.");
    expect(result.stderr).toContain("Usage: sherpa-onnx-tts");
    expect(result.stderr).not.toContain("require is not defined in ES module scope");
  });
});
