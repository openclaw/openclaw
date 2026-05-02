import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { capturePluginRegistration } from "../../../src/plugins/captured-registration.js";
import plugin from "../index.js";
import { callZekeFlowTool, replyToZekeProposal, scrubModelIdentityArgs } from "./client.js";
import { ZEKE_TOOL_NAMES } from "./schemas.js";

describe("zeke native plugin contract", () => {
  it("ships profile templates with the expected native Zeke tool boundaries", () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
    const sprout = readJson(path.join(root, "profiles/sprout.json"));
    const rambo = readJson(path.join(root, "profiles/rambo-internal.json"));
    const external = readJson(path.join(root, "profiles/external-client.json"));
    const contract = readJson(path.join(root, "test/fixtures/zeke/native-tool-contract.json"));

    expect(sprout.tools.allow).toEqual(contract.profileExpectations.sprout);
    expect(rambo.tools.allow).toEqual(contract.profileExpectations.rambo);
    expect(external.tools.allow).toEqual(contract.profileExpectations["external-client"]);

    for (const profile of [sprout, rambo, external]) {
      expect(profile.tools.allow).not.toContain("create_signal");
      expect(profile.tools.deny).toContain("create_signal");
    }
    expect(sprout.tools.allow).toContain("propose_signal");
    expect(rambo.tools.allow).not.toContain("propose_signal");
    expect(external.tools.allow).not.toContain("propose_signal");
    expect(external.tools.deny).toEqual(expect.arrayContaining(ZEKE_TOOL_NAMES));
  });

  it("registers the initial native Zeke tools and keeps create_signal backend-only", () => {
    const captured = capturePluginRegistration(plugin);
    const names = captured.tools.map((tool) => tool.name);

    expect(names).toEqual(ZEKE_TOOL_NAMES);
    expect(names).not.toContain("create_signal");
    expect(names).not.toContain("sessions_spawn");
    expect(captured.agentEventSubscriptions).toHaveLength(0);
  });

  it("forwards authority calls with configured profile and strips model-supplied identity", async () => {
    const calls: Array<{ url: string; init: RequestInit; body: Record<string, unknown> }> = [];
    const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      calls.push({ url: String(url), init: init ?? {}, body });
      return new Response(JSON.stringify({ ok: true, result: { routed: true } }), { status: 200 });
    };

    const result = await callZekeFlowTool(
      {
        baseUrl: "http://zekeflow.local/",
        tokenEnv: "ZEKE_AUTH",
        profile: "sprout",
        operatorId: "openclaw:ross",
        operatorSigningKeyEnv: "ZEKE_OPERATOR_KEY",
      },
      "propose_signal",
      {
        raw_input: "capture this",
        caller: "rambo",
        entity: "bear",
        profile: "external-client",
        callerContext: { seat: "rambo" },
      },
      { toolCallId: "call-1", sessionKey: "agent:sprout:main" },
      { fetchImpl, env: { ZEKE_AUTH: "test-token" } as NodeJS.ProcessEnv },
    );

    expect(result).toEqual({ routed: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("http://zekeflow.local/internal/openclaw/tools/propose_signal");
    expect(calls[0]?.init.headers).toMatchObject({
      authorization: "Bearer test-token",
      "x-zeke-openclaw-profile": "sprout",
    });
    expect(calls[0]?.body.arguments).toEqual({ raw_input: "capture this" });
    expect(calls[0]?.body.session_key).toBe("agent:sprout:main");
  });

  it("fails closed without a bearer token and does not leak token values in errors", async () => {
    await expect(
      callZekeFlowTool(
        {
          baseUrl: "http://zekeflow.local",
          tokenEnv: "ZEKE_AUTH",
          profile: "sprout",
          operatorId: "openclaw:ross",
          operatorSigningKeyEnv: "ZEKE_OPERATOR_KEY",
        },
        "ask_zeke_context",
        { query: "status" },
        {},
        { env: {} as NodeJS.ProcessEnv },
      ),
    ).rejects.toThrow(/Missing ZekeFlow authority token env: ZEKE_AUTH/u);

    expect(
      scrubModelIdentityArgs({
        caller: "rambo",
        entity: "bear",
        profile: "external-client",
        callerContext: {},
        envelope: {},
        query: "status",
      }),
    ).toEqual({ query: "status" });
  });

  it("signs same-chat proposal replies with the configured operator key", async () => {
    const calls: Array<{ init: RequestInit; body: Record<string, unknown> }> = [];
    const fetchImpl = async (_url: string | URL | Request, init?: RequestInit) => {
      calls.push({ init: init ?? {}, body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify({ ok: true, result: { action: "decline" } }), {
        status: 200,
      });
    };

    await replyToZekeProposal(
      {
        baseUrl: "http://zekeflow.local",
        tokenEnv: "ZEKE_AUTH",
        profile: "sprout",
        operatorId: "openclaw:ross",
        operatorSigningKeyEnv: "ZEKE_OPERATOR_KEY",
      },
      { text: "no", sessionKey: "s9-spoof", operatorId: "openclaw:ross" },
      {
        fetchImpl,
        env: { ZEKE_AUTH: "test-token", ZEKE_OPERATOR_KEY: "operator-key" } as NodeJS.ProcessEnv,
      },
    );

    expect(calls[0]?.init.headers).toMatchObject({
      "x-zeke-operator-id": "openclaw:ross",
      "x-zeke-openclaw-profile": "sprout",
    });
    expect(
      String((calls[0]?.init.headers as Record<string, string>)["x-zeke-operator-signature"]),
    ).toMatch(/^[a-f0-9]{64}$/u);
    expect(calls[0]?.body).toMatchObject({
      text: "no",
      session_key: "s9-spoof",
      message_origin: "operator",
      decided_by: "openclaw:ross",
    });
  });

  it("does not import or write direct ZekeFlow state", () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const offenders: Array<{ file: string; pattern: string }> = [];
    const forbidden = [
      "better-sqlite3",
      "sqlite3",
      "node:sqlite",
      "events.db",
      "pending_proposals",
      "Cognee",
      "appendEvent",
      "insertSignal",
      "fs.writeFile",
      "fs.appendFile",
      "zeke-repo/zekeflow",
    ];

    for (const file of listFiles(root)) {
      const body = readFileSync(file, "utf8");
      for (const pattern of forbidden) {
        if (body.includes(pattern)) {
          offenders.push({ file: path.relative(root, file), pattern });
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});

function readJson(file: string): any {
  return JSON.parse(readFileSync(file, "utf8"));
}

function listFiles(root: string): string[] {
  const result: string[] = [];
  for (const name of readdirSync(root)) {
    const full = path.join(root, name);
    const info = statSync(full);
    if (info.isDirectory()) {
      if (name !== "node_modules" && name !== "dist") {
        result.push(...listFiles(full));
      }
    } else if (info.isFile() && /\.(?:ts|json)$/u.test(name) && !name.endsWith(".test.ts")) {
      result.push(full);
    }
  }
  return result;
}
