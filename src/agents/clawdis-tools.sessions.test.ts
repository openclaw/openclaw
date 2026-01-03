import { describe, expect, it, vi } from "vitest";

const callGatewayMock = vi.fn();

vi.mock("../gateway/call.js", () => ({
  callGateway: (opts: unknown) => callGatewayMock(opts),
}));

vi.mock("../config/config.js", () => ({
  loadConfig: () => ({
    session: { mainKey: "main", scope: "per-sender" },
  }),
  resolveGatewayPort: () => 18789,
}));

import { createClawdisTools } from "./clawdis-tools.js";

describe("sessions tools", () => {
  it("sessions_list filters kinds and includes messages", async () => {
    callGatewayMock.mockImplementation(async (opts: any) => {
      if (opts.method === "sessions.list") {
        return {
          path: "/tmp/sessions.json",
          sessions: [
            {
              key: "main",
              kind: "direct",
              sessionId: "s-main",
              updatedAt: 10,
              lastChannel: "whatsapp",
            },
            {
              key: "discord:group:dev",
              kind: "group",
              sessionId: "s-group",
              updatedAt: 11,
              surface: "discord",
              displayName: "discord:g-dev",
            },
            {
              key: "cron:job-1",
              kind: "direct",
              sessionId: "s-cron",
              updatedAt: 9,
            },
            { key: "global", kind: "global" },
            { key: "unknown", kind: "unknown" },
          ],
        };
      }
      if (opts.method === "chat.history") {
        return {
          messages: [
            { role: "toolResult", content: [] },
            {
              role: "assistant",
              content: [{ type: "text", text: "hi" }],
            },
          ],
        };
      }
      return {};
    });

    const tool = createClawdisTools().find(
      (candidate) => candidate.name === "sessions_list",
    );
    expect(tool).toBeDefined();
    if (!tool) throw new Error("missing sessions_list tool");

    const result = await tool.execute("call1", { messageLimit: 1 });
    const details = result.details as { sessions?: any[] };
    expect(details.sessions).toHaveLength(3);
    const main = details.sessions?.find((s) => s.key === "main");
    expect(main?.provider).toBe("whatsapp");
    expect(main?.messages?.length).toBe(1);
    expect(main?.messages?.[0]?.role).toBe("assistant");

    const cronOnly = await tool.execute("call2", { kinds: ["cron"] });
    const cronDetails = cronOnly.details as { sessions?: any[] };
    expect(cronDetails.sessions).toHaveLength(1);
    expect(cronDetails.sessions?.[0]?.kind).toBe("cron");
  });

  it("sessions_history filters tool messages by default", async () => {
    callGatewayMock.mockImplementation(async (opts: any) => {
      if (opts.method === "chat.history") {
        return {
          messages: [
            { role: "toolResult", content: [] },
            { role: "assistant", content: [{ type: "text", text: "ok" }] },
          ],
        };
      }
      return {};
    });

    const tool = createClawdisTools().find(
      (candidate) => candidate.name === "sessions_history",
    );
    expect(tool).toBeDefined();
    if (!tool) throw new Error("missing sessions_history tool");

    const result = await tool.execute("call3", { sessionKey: "main" });
    const details = result.details as { messages?: any[] };
    expect(details.messages).toHaveLength(1);
    expect(details.messages?.[0]?.role).toBe("assistant");

    const withTools = await tool.execute("call4", {
      sessionKey: "main",
      includeTools: true,
    });
    const withToolsDetails = withTools.details as { messages?: any[] };
    expect(withToolsDetails.messages).toHaveLength(2);
  });

  it("sessions_send supports fire-and-forget and wait", async () => {
    callGatewayMock.mockImplementation(async (opts: any) => {
      if (opts.method === "agent") {
        return opts.expectFinal
          ? { runId: "run-1", status: "ok" }
          : { runId: "run-1", status: "accepted" };
      }
      if (opts.method === "chat.history") {
        return {
          messages: [
            { role: "assistant", content: [{ type: "text", text: "done" }] },
          ],
        };
      }
      return {};
    });

    const tool = createClawdisTools().find(
      (candidate) => candidate.name === "sessions_send",
    );
    expect(tool).toBeDefined();
    if (!tool) throw new Error("missing sessions_send tool");

    const fire = await tool.execute("call5", {
      sessionKey: "main",
      message: "ping",
      timeoutSeconds: 0,
    });
    expect(fire.details).toMatchObject({ status: "accepted", runId: "run-1" });

    const waitPromise = tool.execute("call6", {
      sessionKey: "main",
      message: "wait",
      timeoutSeconds: 5,
    });
    const waited = await waitPromise;
    expect(waited.details).toMatchObject({
      status: "ok",
      runId: "run-1",
      reply: "done",
    });
  });
});
