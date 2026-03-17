import { describe, expect, it } from "vitest";
import { buildSystemPrompt } from "./helpers.js";

// Helper: call buildSystemPrompt with minimal required params
function buildPrompt(sessionKey?: string): string {
  return buildSystemPrompt({
    workspaceDir: "/tmp/openclaw",
    modelDisplay: "test-model",
    tools: [],
    heartbeatPrompt: "ping",
    sessionKey,
  });
}

describe("buildSystemPrompt (cli-runner/helpers)", () => {
  it("includes Heartbeats section for a normal session without sessionKey", () => {
    // no sessionKey => full mode => Heartbeats section present
    const prompt = buildPrompt();
    expect(prompt).toContain("## Heartbeats");
    expect(prompt).toContain("HEARTBEAT_OK");
  });

  it("includes Heartbeats section for a regular agent session key", () => {
    // agent:agentId:main => full mode
    const prompt = buildPrompt("agent:default:main");
    expect(prompt).toContain("## Heartbeats");
    expect(prompt).toContain("HEARTBEAT_OK");
  });

  it("suppresses Heartbeats section for a cron session key", () => {
    // agent:agentId:cron:jobId:run:runId => minimal mode => no Heartbeats section
    const prompt = buildPrompt("agent:default:cron:daily-report:run:001");
    expect(prompt).not.toContain("## Heartbeats");
    expect(prompt).not.toContain("HEARTBEAT_OK");
  });

  it("suppresses Heartbeats section for a subagent session key", () => {
    // agent:agentId:subagent:... => minimal mode
    const prompt = buildPrompt("agent:default:subagent:sub1");
    expect(prompt).not.toContain("## Heartbeats");
    expect(prompt).not.toContain("HEARTBEAT_OK");
  });

  it("omits extended sections for cron sessions (Messaging, Silent Replies, etc.)", () => {
    const prompt = buildPrompt("agent:default:cron:hourly:run:0042");
    expect(prompt).not.toContain("## Messaging");
    expect(prompt).not.toContain("## Silent Replies");
    // Safety section must still be present
    expect(prompt).toContain("## Safety");
  });
});
