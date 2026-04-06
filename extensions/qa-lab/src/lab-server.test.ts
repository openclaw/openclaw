import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startQaLabServer } from "./lab-server.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
});

describe("qa-lab server", () => {
  it("serves bootstrap state and writes a self-check report", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "qa-lab-test-"));
    cleanups.push(async () => {
      await rm(tempDir, { recursive: true, force: true });
    });
    const outputPath = path.join(tempDir, "self-check.md");

    const lab = await startQaLabServer({
      host: "127.0.0.1",
      port: 0,
      outputPath,
      controlUiUrl: "http://127.0.0.1:18789/",
      controlUiToken: "qa-token",
    });
    cleanups.push(async () => {
      await lab.stop();
    });

    const bootstrapResponse = await fetch(`${lab.baseUrl}/api/bootstrap`);
    expect(bootstrapResponse.status).toBe(200);
    const bootstrap = (await bootstrapResponse.json()) as {
      controlUiUrl: string | null;
      controlUiEmbeddedUrl: string | null;
      kickoffTask: string;
      scenarios: Array<{ id: string; title: string }>;
      defaults: { conversationId: string; senderId: string };
      runner: { status: string; selection: { providerMode: string; scenarioIds: string[] } };
    };
    expect(bootstrap.defaults.conversationId).toBe("qa-operator");
    expect(bootstrap.defaults.senderId).toBe("qa-operator");
    expect(bootstrap.controlUiUrl).toBe("http://127.0.0.1:18789/");
    expect(bootstrap.controlUiEmbeddedUrl).toBe("http://127.0.0.1:18789/#token=qa-token");
    expect(bootstrap.kickoffTask).toContain("Lobster Invaders");
    expect(bootstrap.scenarios.length).toBeGreaterThanOrEqual(10);
    expect(bootstrap.scenarios.some((scenario) => scenario.id === "dm-chat-baseline")).toBe(true);
    expect(bootstrap.runner.status).toBe("idle");
    expect(bootstrap.runner.selection.providerMode).toBe("mock-openai");
    expect(bootstrap.runner.selection.scenarioIds).toHaveLength(bootstrap.scenarios.length);

    const messageResponse = await fetch(`${lab.baseUrl}/api/inbound/message`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        conversation: { id: "bob", kind: "direct" },
        senderId: "bob",
        senderName: "Bob",
        text: "hello from test",
      }),
    });
    expect(messageResponse.status).toBe(200);

    const stateResponse = await fetch(`${lab.baseUrl}/api/state`);
    expect(stateResponse.status).toBe(200);
    const snapshot = (await stateResponse.json()) as {
      messages: Array<{ direction: string; text: string }>;
    };
    expect(snapshot.messages.some((message) => message.text === "hello from test")).toBe(true);

    const result = await lab.runSelfCheck();
    expect(result.scenarioResult.status).toBe("pass");
    const markdown = await readFile(outputPath, "utf8");
    expect(markdown).toContain("Synthetic Slack-class roundtrip");
    expect(markdown).toContain("- Status: pass");
  });

  it("injects the kickoff task on demand and on startup", async () => {
    const autoKickoffLab = await startQaLabServer({
      host: "127.0.0.1",
      port: 0,
      sendKickoffOnStart: true,
    });
    cleanups.push(async () => {
      await autoKickoffLab.stop();
    });

    const autoSnapshot = (await (await fetch(`${autoKickoffLab.baseUrl}/api/state`)).json()) as {
      messages: Array<{ text: string }>;
    };
    expect(autoSnapshot.messages.some((message) => message.text.includes("QA mission:"))).toBe(
      true,
    );

    const manualLab = await startQaLabServer({
      host: "127.0.0.1",
      port: 0,
    });
    cleanups.push(async () => {
      await manualLab.stop();
    });

    const kickoffResponse = await fetch(`${manualLab.baseUrl}/api/kickoff`, {
      method: "POST",
    });
    expect(kickoffResponse.status).toBe(200);

    const manualSnapshot = (await (await fetch(`${manualLab.baseUrl}/api/state`)).json()) as {
      messages: Array<{ text: string }>;
    };
    expect(
      manualSnapshot.messages.some((message) => message.text.includes("Lobster Invaders")),
    ).toBe(true);
  });

  it("proxies control-ui paths through /control-ui", async () => {
    const upstream = createServer((req, res) => {
      if ((req.url ?? "/") === "/healthz") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, status: "live" }));
        return;
      }
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "x-frame-options": "DENY",
        "content-security-policy": "default-src 'self'; frame-ancestors 'none';",
      });
      res.end("<!doctype html><title>control-ui</title><h1>Control UI</h1>");
    });
    await new Promise<void>((resolve, reject) => {
      upstream.once("error", reject);
      upstream.listen(0, "127.0.0.1", () => resolve());
    });
    cleanups.push(
      async () =>
        await new Promise<void>((resolve, reject) =>
          upstream.close((error) => (error ? reject(error) : resolve())),
        ),
    );

    const address = upstream.address();
    if (!address || typeof address === "string") {
      throw new Error("expected upstream address");
    }

    const lab = await startQaLabServer({
      host: "127.0.0.1",
      port: 0,
      advertiseHost: "127.0.0.1",
      advertisePort: 43124,
      controlUiProxyTarget: `http://127.0.0.1:${address.port}/`,
      controlUiToken: "proxy-token",
    });
    cleanups.push(async () => {
      await lab.stop();
    });

    const bootstrap = (await (await fetch(`${lab.listenUrl}/api/bootstrap`)).json()) as {
      controlUiUrl: string | null;
      controlUiEmbeddedUrl: string | null;
    };
    expect(bootstrap.controlUiUrl).toBe("http://127.0.0.1:43124/control-ui/");
    expect(bootstrap.controlUiEmbeddedUrl).toBe(
      "http://127.0.0.1:43124/control-ui/#token=proxy-token",
    );

    const healthResponse = await fetch(`${lab.listenUrl}/control-ui/healthz`);
    expect(healthResponse.status).toBe(200);
    expect(await healthResponse.json()).toEqual({ ok: true, status: "live" });

    const rootResponse = await fetch(`${lab.listenUrl}/control-ui/`);
    expect(rootResponse.status).toBe(200);
    expect(rootResponse.headers.get("x-frame-options")).toBeNull();
    expect(rootResponse.headers.get("content-security-policy")).toContain("frame-ancestors 'self'");
    expect(await rootResponse.text()).toContain("Control UI");
  });

  it("serves the built QA UI bundle when available", async () => {
    const lab = await startQaLabServer({
      host: "127.0.0.1",
      port: 0,
    });
    cleanups.push(async () => {
      await lab.stop();
    });

    const rootResponse = await fetch(`${lab.baseUrl}/`);
    expect(rootResponse.status).toBe(200);
    const html = await rootResponse.text();
    expect(html).not.toContain("QA Lab UI not built");
    expect(html).toContain("<title>");
  });

  it("can disable the embedded echo gateway for real-suite runs", async () => {
    const lab = await startQaLabServer({
      host: "127.0.0.1",
      port: 0,
      embeddedGateway: "disabled",
    });
    cleanups.push(async () => {
      await lab.stop();
    });

    await fetch(`${lab.baseUrl}/api/inbound/message`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        conversation: { id: "bob", kind: "direct" },
        senderId: "bob",
        senderName: "Bob",
        text: "hello from suite",
      }),
    });

    await new Promise((resolve) => setTimeout(resolve, 800));
    const snapshot = (await (await fetch(`${lab.baseUrl}/api/state`)).json()) as {
      messages: Array<{ direction: string }>;
    };
    expect(snapshot.messages.filter((message) => message.direction === "outbound")).toHaveLength(0);
  });

  it("exposes structured outcomes and can attach control-ui after startup", async () => {
    const lab = await startQaLabServer({
      host: "127.0.0.1",
      port: 0,
      embeddedGateway: "disabled",
    });
    cleanups.push(async () => {
      await lab.stop();
    });

    const initialOutcomes = (await (await fetch(`${lab.baseUrl}/api/outcomes`)).json()) as {
      run: null | unknown;
    };
    expect(initialOutcomes.run).toBeNull();

    lab.setScenarioRun({
      kind: "suite",
      status: "running",
      startedAt: "2026-04-06T09:00:00.000Z",
      scenarios: [
        {
          id: "channel-chat-baseline",
          name: "Channel baseline conversation",
          status: "pass",
          steps: [{ name: "reply check", status: "pass", details: "ok" }],
          finishedAt: "2026-04-06T09:00:01.000Z",
        },
        {
          id: "cron-one-minute-ping",
          name: "Cron one-minute ping",
          status: "running",
          startedAt: "2026-04-06T09:00:02.000Z",
        },
      ],
    });
    lab.setControlUi({
      controlUiUrl: "http://127.0.0.1:18789/",
      controlUiToken: "late-token",
    });

    const bootstrap = (await (await fetch(`${lab.baseUrl}/api/bootstrap`)).json()) as {
      controlUiEmbeddedUrl: string | null;
    };
    expect(bootstrap.controlUiEmbeddedUrl).toBe("http://127.0.0.1:18789/#token=late-token");

    const outcomes = (await (await fetch(`${lab.baseUrl}/api/outcomes`)).json()) as {
      run: {
        status: string;
        counts: { total: number; passed: number; running: number };
        scenarios: Array<{ id: string; status: string }>;
      };
    };
    expect(outcomes.run.status).toBe("running");
    expect(outcomes.run.counts).toEqual({
      total: 2,
      pending: 0,
      running: 1,
      passed: 1,
      failed: 0,
      skipped: 0,
    });
    expect(outcomes.run.scenarios.map((scenario) => scenario.id)).toEqual([
      "channel-chat-baseline",
      "cron-one-minute-ping",
    ]);
  });
});
