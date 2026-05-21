import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { testing } from "./whatsapp-live.runtime.js";

const execFileAsync = promisify(execFile);

async function createTgz(params: { entries: Record<string, string>; root: string }) {
  const sourceDir = path.join(params.root, "src");
  await fs.mkdir(sourceDir, { recursive: true });
  for (const [relativePath, content] of Object.entries(params.entries)) {
    const filePath = path.join(sourceDir, relativePath);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content);
  }
  const archivePath = path.join(params.root, "archive.tgz");
  await execFileAsync("tar", ["-czf", archivePath, "-C", sourceDir, "."]);
  return await fs.readFile(archivePath, "base64");
}

describe("WhatsApp QA live runtime", () => {
  it("parses credential payloads and normalizes phone numbers", () => {
    const payload = testing.parseWhatsAppQaCredentialPayload({
      driverPhoneE164: "15550000001",
      sutPhoneE164: "+15550000002",
      driverAuthArchiveBase64: "driver",
      sutAuthArchiveBase64: "sut",
    });
    expect(payload.driverPhoneE164).toBe("+15550000001");
    expect(payload.sutPhoneE164).toBe("+15550000002");
    expect(payload.driverAuthArchiveBase64).toBe("driver");
    expect(payload.sutAuthArchiveBase64).toBe("sut");
  });

  it("rejects credential payloads that reuse the same phone", () => {
    expect(() =>
      testing.parseWhatsAppQaCredentialPayload({
        driverPhoneE164: "+15550000001",
        sutPhoneE164: "+15550000001",
        driverAuthArchiveBase64: "driver",
        sutAuthArchiveBase64: "sut",
      }),
    ).toThrow("requires two distinct WhatsApp phone numbers");
  });

  it("redacts observed message content and phone metadata by default", () => {
    expect(
      testing.toObservedWhatsAppArtifacts({
        includeContent: false,
        redactMetadata: true,
        messages: [
          {
            fromJid: "15550000002@s.whatsapp.net",
            fromPhoneE164: "+15550000002",
            matchedScenario: true,
            messageId: "msg-1",
            observedAt: "2026-05-04T12:00:00.000Z",
            scenarioId: "whatsapp-canary",
            scenarioTitle: "WhatsApp DM canary",
            text: "secret body",
          },
        ],
      }),
    ).toEqual([
      {
        matchedScenario: true,
        observedAt: "2026-05-04T12:00:00.000Z",
        scenarioId: "whatsapp-canary",
        scenarioTitle: "WhatsApp DM canary",
      },
    ]);
  });

  it("keeps observed message content only when capture is requested", () => {
    expect(
      testing.toObservedWhatsAppArtifacts({
        includeContent: true,
        redactMetadata: true,
        messages: [
          {
            fromPhoneE164: "+15550000002",
            observedAt: "2026-05-04T12:00:00.000Z",
            text: "captured body",
          },
        ],
      }),
    ).toEqual([
      {
        observedAt: "2026-05-04T12:00:00.000Z",
        text: "captured body",
      },
    ]);
  });

  it("unpacks auth archives into a caller-provided temp directory", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-wa-qa-test-"));
    try {
      const archiveBase64 = await createTgz({
        root: tempRoot,
        entries: {
          "creds.json": "{}\n",
          "session/key.json": "{}\n",
        },
      });
      const authDir = await testing.unpackWhatsAppAuthArchive({
        archiveBase64,
        label: "driver",
        parentDir: tempRoot,
      });
      await expect(fs.readFile(path.join(authDir, "creds.json"), "utf8")).resolves.toBe("{}\n");
      await expect(fs.readFile(path.join(authDir, "session/key.json"), "utf8")).resolves.toBe(
        "{}\n",
      );
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("rejects unsafe archive entries before extraction", () => {
    expect(() => testing.assertSafeArchiveEntries(["../creds.json"])).toThrow("unsafe entry");
    expect(() => testing.assertSafeArchiveEntries(["/tmp/creds.json"])).toThrow("unsafe entry");
  });

  it("registers the WhatsApp canary, RTT, and pairing scenarios", () => {
    const scenarios = testing.findScenarios([
      "whatsapp-canary",
      "whatsapp-canary-rtt",
      "whatsapp-pairing-block",
    ]);
    expect(scenarios.map(({ id }) => id)).toEqual([
      "whatsapp-canary",
      "whatsapp-canary-rtt",
      "whatsapp-pairing-block",
    ]);

    const rttRun = scenarios.find(({ id }) => id === "whatsapp-canary-rtt")?.buildRun();
    expect(rttRun).toMatchObject({
      configMode: "allowlist",
      expectReply: true,
      target: "dm",
    });
    expect(rttRun?.input).toContain("Reply with only this exact marker:");
  });

  it("uses automatic visible replies for WhatsApp group mention gating", () => {
    const [scenario] = testing.findScenarios(["whatsapp-mention-gating"]);
    const scenarioRun = scenario.buildRun();
    expect(scenarioRun.input).toContain("openclawqa reply with only this exact marker");
    expect(scenarioRun.input).not.toContain("visible reply tool check");

    const cfg = testing.buildWhatsAppQaConfig(
      {
        agents: {
          defaults: {
            models: {
              "openai/gpt-5.5": {
                params: {
                  thinking: "high",
                },
              },
            },
          },
          list: [{ id: "qa", tools: { profile: "coding" } }],
        },
        tools: {
          profile: "coding",
          deny: ["exec"],
          web: { fetch: { enabled: true }, search: { enabled: true, maxResults: 4 } },
        },
      },
      {
        allowFrom: ["+15550000001"],
        authDir: "/tmp/openclaw-whatsapp-qa-auth",
        dmPolicy: "allowlist",
        groupJid: "120363000000000000@g.us",
        sutAccountId: "sut",
      },
    );
    expect(cfg.agents?.defaults?.skipBootstrap).toBe(true);
    expect(cfg.agents?.defaults?.heartbeat?.every).toBe("0m");
    expect(cfg.agents?.defaults?.skills).toEqual([]);
    expect(cfg.agents?.defaults?.thinkingDefault).toBe("off");
    expect(cfg.agents?.defaults?.models?.["openai/gpt-5.5"]?.agentRuntime).toEqual({ id: "pi" });
    expect(cfg.agents?.defaults?.models?.["openai/gpt-5.5"]?.params?.thinking).toBe("off");
    expect(cfg.tools?.profile).toBe("messaging");
    expect(cfg.tools?.deny).toEqual([
      "exec",
      "bundle-mcp",
      "session_status",
      "sessions_*",
      "web_search",
    ]);
    expect(cfg.tools?.web?.fetch?.enabled).toBe(true);
    expect(cfg.tools?.web?.search?.enabled).toBe(false);
    expect(cfg.tools?.web?.search?.maxResults).toBe(4);
    expect(cfg.agents?.list?.[0]?.heartbeat?.every).toBe("0m");
    expect(cfg.agents?.list?.[0]?.skills).toEqual([]);
    expect(cfg.agents?.list?.[0]?.tools?.profile).toBe("messaging");
    expect(cfg.agents?.list?.[0]?.tools?.deny).toEqual([
      "bundle-mcp",
      "session_status",
      "sessions_*",
      "web_search",
    ]);
    expect(cfg.messages?.groupChat?.visibleReplies).toBe("automatic");
    expect(cfg.messages?.groupChat?.mentionPatterns).toContain("\\bopenclawqa\\b");
  });

  it("renders WhatsApp live phase timings in the QA report", () => {
    const report = testing.renderWhatsAppQaMarkdown({
      cleanupIssues: [],
      credentialSource: "convex",
      finishedAt: "2026-05-18T10:00:05.000Z",
      redactMetadata: true,
      scenarios: [
        {
          id: "whatsapp-canary",
          title: "WhatsApp DM canary",
          status: "pass",
          details: "reply matched in 3210ms",
          rttMs: 3210,
          timings: {
            gatewayStartMs: 1200,
            channelReadyMs: 21000,
            sendTextMs: 450,
            waitForReplyMs: 2760,
          },
        },
      ],
      startedAt: "2026-05-18T10:00:00.000Z",
    });

    expect(report).toContain(
      "- Timing: gatewayStart=1200ms, channelReady=21000ms, sendText=450ms, waitForReply=2760ms",
    );
  });

  it("arms WhatsApp gateway diagnostics only when requested", () => {
    expect(
      testing.buildWhatsAppGatewayRuntimeEnvPatch({
        env: {
          OPENCLAW_QA_GATEWAY_HEAP_CHECKPOINTS: "0",
          OPENCLAW_QA_WHATSAPP_MODEL_TRANSPORT_DEBUG: "0",
          OPENCLAW_QA_WHATSAPP_TRACE: "0",
        },
        tracePath: "/tmp/openclaw-whatsapp-trace.jsonl",
      }),
    ).toBeUndefined();
    expect(
      testing.buildWhatsAppGatewayRuntimeEnvPatch({
        env: {
          OPENCLAW_QA_GATEWAY_HEAP_CHECKPOINTS: "1",
          OPENCLAW_QA_WHATSAPP_MODEL_TRANSPORT_DEBUG: "1",
          OPENCLAW_QA_WHATSAPP_TRACE: "1",
          OPENCLAW_DEBUG_MODEL_PAYLOAD: "detail",
          OPENCLAW_DEBUG_SSE: "summary",
          NODE_OPTIONS: "--max-old-space-size=4096",
        },
        timelinePath: "/tmp/openclaw-whatsapp-timeline.jsonl",
        tracePath: "/tmp/openclaw-whatsapp-trace.jsonl",
      }),
    ).toEqual({
      NODE_OPTIONS: "--max-old-space-size=4096 --heapsnapshot-signal=SIGUSR2",
      OPENCLAW_DIAGNOSTICS: "timeline",
      OPENCLAW_DIAGNOSTICS_TIMELINE_PATH: "/tmp/openclaw-whatsapp-timeline.jsonl",
      OPENCLAW_DEBUG_MODEL_PAYLOAD: "detail",
      OPENCLAW_DEBUG_MODEL_TRANSPORT: "1",
      OPENCLAW_DEBUG_SSE: "summary",
      OPENCLAW_QA_WHATSAPP_TRACE: "1",
      OPENCLAW_QA_WHATSAPP_TRACE_PATH: "/tmp/openclaw-whatsapp-trace.jsonl",
    });
  });

  it("preserves gateway debug artifacts for model transport diagnostics", () => {
    expect(
      testing.shouldPreserveWhatsAppGatewayDebugArtifacts({
        OPENCLAW_QA_WHATSAPP_MODEL_TRANSPORT_DEBUG: "0",
      }),
    ).toBe(false);
    expect(
      testing.shouldPreserveWhatsAppGatewayDebugArtifacts({
        OPENCLAW_QA_WHATSAPP_MODEL_TRANSPORT_DEBUG: "1",
      }),
    ).toBe(true);
  });

  it("detects complete heap snapshot files before copying", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-wa-heap-test-"));
    try {
      const completePath = path.join(tempRoot, "complete.heapsnapshot");
      const partialPath = path.join(tempRoot, "partial.heapsnapshot");
      await fs.writeFile(
        completePath,
        '{"snapshot":{},"nodes":[],"edges":[],"strings":[]}',
        "utf8",
      );
      await fs.writeFile(partialPath, '{"snapshot":{},"nodes":[],"edges":[],"strings":[', "utf8");

      await expect(
        testing.heapSnapshotLooksComplete(completePath, (await fs.stat(completePath)).size),
      ).resolves.toBe(true);
      await expect(
        testing.heapSnapshotLooksComplete(partialPath, (await fs.stat(partialPath)).size),
      ).resolves.toBe(false);
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("fails explicitly requested group scenarios when group credentials are missing", () => {
    const [scenario] = testing.findScenarios(["whatsapp-mention-gating"]);

    const implicitResult = testing.createMissingGroupJidScenarioResult({
      explicitScenarioSelection: false,
      scenario,
    });
    expect(implicitResult.id).toBe("whatsapp-mention-gating");
    expect(implicitResult.status).toBe("skip");

    const explicitResult = testing.createMissingGroupJidScenarioResult({
      explicitScenarioSelection: true,
      scenario,
    });
    expect(explicitResult.id).toBe("whatsapp-mention-gating");
    expect(explicitResult.status).toBe("fail");
    expect(explicitResult.details).toContain("requested scenario requires groupJid");
  });

  it("attributes pre-scenario setup failures to the selected scenario", () => {
    const scenarios = testing.findScenarios(["whatsapp-mention-gating"]);
    const scenarioResults: Array<{
      details: string;
      id: string;
      status: "fail" | "pass" | "skip";
      title: string;
    }> = [];

    testing.appendPreScenarioFailureResults({
      details: "setup exploded",
      scenarioResults,
      scenarios,
    });

    expect(scenarioResults).toEqual([
      {
        id: "whatsapp-mention-gating",
        title: "WhatsApp group mention gating",
        status: "fail",
        details: "setup exploded",
      },
    ]);
  });

  it("classifies WhatsApp driver connection closures as retryable", () => {
    expect(testing.isTransientWhatsAppQaDriverError(new Error("Connection Closed"))).toBe(true);
    expect(
      testing.isTransientWhatsAppQaDriverError(new Error("status 440: session conflict")),
    ).toBe(true);
    expect(testing.isTransientWhatsAppQaDriverError(new Error("Stream Errored (conflict)"))).toBe(
      true,
    );
    expect(
      testing.isTransientWhatsAppQaDriverError(
        new Error("timed out waiting for WhatsApp QA driver message"),
      ),
    ).toBe(true);
    expect(testing.isTransientWhatsAppQaDriverError(new Error("timed out waiting"))).toBe(false);
  });
});
