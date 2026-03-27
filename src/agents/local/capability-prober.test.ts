import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { StreamFn } from "@mariozechner/pi-agent-core";
import { createAssistantMessageEventStream } from "@mariozechner/pi-ai";
import { describe, it, expect } from "vitest";
import { getModelCapability } from "./capabilities-cache.js";
import { runBackgroundCapabilityProbe } from "./capability-prober.js";

function makeDoneStreamFn(text: string): StreamFn {
  return () => {
    const stream = createAssistantMessageEventStream();
    setTimeout(() => {
      stream.push({
        type: "done",
        reason: "stop",
        message: {
          role: "assistant",
          content: [{ type: "text", text }],
          stopReason: "stop",
          api: "test",
          provider: "test",
          model: "test",
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
          timestamp: Date.now(),
        },
      });
      stream.end();
    }, 0);
    return Promise.resolve(stream);
  };
}

async function makeConfigDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-capability-prober-"));
  await fs.mkdir(path.join(dir, "mpm"), { recursive: true });
  return dir;
}

describe("runBackgroundCapabilityProbe", () => {
  it("keeps capability unknown when the probe returns plain text without a native tool call", async () => {
    const configDir = await makeConfigDir();

    await runBackgroundCapabilityProbe({
      streamFn: makeDoneStreamFn("Sorry, I cannot do that."),
      model: { id: "plain-text-probe" },
      modelId: "plain-text-probe",
      providerId: "test-provider",
      configDir,
    });

    await expect(getModelCapability(configDir, "test-provider", "plain-text-probe")).resolves.toBe(
      "unknown",
    );
  });

  it("marks capability as react when the probe returns explicit ReAct markers", async () => {
    const configDir = await makeConfigDir();

    await runBackgroundCapabilityProbe({
      streamFn: makeDoneStreamFn("Thought: I should reason.\nAction: check_capability_ping"),
      model: { id: "react-probe" },
      modelId: "react-probe",
      providerId: "test-provider",
      configDir,
    });

    await expect(getModelCapability(configDir, "test-provider", "react-probe")).resolves.toBe(
      "react",
    );
  });
});
