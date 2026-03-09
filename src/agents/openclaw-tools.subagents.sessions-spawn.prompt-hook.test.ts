import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import "./test-helpers/fast-core-tools.js";
import {
  getCallGatewayMock,
  getSessionsSpawnTool,
  resetSessionsSpawnConfigOverride,
  setSessionsSpawnConfigOverride,
} from "./openclaw-tools.subagents.sessions-spawn.test-harness.js";
import { resetSubagentRegistryForTests } from "./subagent-registry.js";

const callGatewayMock = getCallGatewayMock();

describe("sessions_spawn subagent prompt hook", () => {
  beforeEach(() => {
    resetSessionsSpawnConfigOverride();
    resetSubagentRegistryForTests();
    callGatewayMock.mockReset();
  });

  it("wraps subagent task with configured prefix/suffix files", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-hook-"));
    const prefixPath = path.join(tmpDir, "prefix.md");
    const suffixPath = path.join(tmpDir, "suffix.md");
    await fs.writeFile(prefixPath, "[HOOK PREFIX]", "utf8");
    await fs.writeFile(suffixPath, "[HOOK SUFFIX]", "utf8");

    setSessionsSpawnConfigOverride({
      session: { mainKey: "main", scope: "per-sender" },
      agents: {
        subagent: {
          promptHook: {
            enabled: true,
            mode: "wrap",
            prefixPath,
            suffixPath,
            maxBytes: 1024,
            onMissing: "warn",
          },
        },
      },
    });

    const calls: Array<{ method?: string; params?: unknown }> = [];
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string; params?: unknown };
      calls.push(request);
      if (request.method === "sessions.patch") {
        return { ok: true };
      }
      if (request.method === "agent") {
        return { runId: "run-hook", status: "accepted" };
      }
      return {};
    });

    const tool = await getSessionsSpawnTool({
      agentSessionKey: "agent:main:main",
      agentChannel: "discord",
    });

    const result = await tool.execute("call-hook-wrap", { task: "ORIGINAL TASK" });
    expect(result.details).toMatchObject({ status: "accepted" });

    const agentCall = calls.find((call) => call.method === "agent");
    const message = (agentCall?.params as { message?: string } | undefined)?.message ?? "";
    expect(message).toContain("[HOOK PREFIX]");
    expect(message).toContain("ORIGINAL TASK");
    expect(message).toContain("[HOOK SUFFIX]");
    expect(message.indexOf("[HOOK PREFIX]")).toBeLessThan(message.indexOf("ORIGINAL TASK"));
    expect(message.indexOf("ORIGINAL TASK")).toBeLessThan(message.indexOf("[HOOK SUFFIX]"));
  });
});
