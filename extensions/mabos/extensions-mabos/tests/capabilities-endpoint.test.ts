/**
 * Capabilities HTTP Endpoint Tests
 *
 * Validates GET /mabos/api/capabilities returns the correct unified JSON
 * shape with MABOS tools (categorized) and OpenClaw eligible skills.
 */

import assert from "node:assert/strict";
import { describe, it, beforeEach } from "vitest";
import register from "../index.js";

// ── Mock OpenClawPluginApi (mirrors plugin.test.ts pattern) ──

type RouteRegistration = {
  path: string;
  handler: Function;
};

function createMockApi() {
  const tools: any[] = [];
  const hooks: any[] = [];
  const logs: string[] = [];
  const routes: RouteRegistration[] = [];

  const api = {
    id: "mabos-test",
    name: "MABOS Test",
    version: "0.1.0",
    description: "Test instance",
    source: "test",
    config: {
      agents: {
        defaults: {
          workspace: "/tmp/mabos-test",
        },
      },
      gateway: {
        auth: {
          mode: "none",
        },
      },
    } as any,
    pluginConfig: {},
    runtime: {} as any,
    logger: {
      debug: (msg: string) => logs.push(`[debug] ${msg}`),
      info: (msg: string) => logs.push(`[info] ${msg}`),
      warn: (msg: string) => logs.push(`[warn] ${msg}`),
      error: (msg: string) => logs.push(`[error] ${msg}`),
    },
    registerTool: (tool: any) => {
      tools.push(tool);
    },
    registerHook: (events: any, handler: any) => {
      hooks.push({ events, handler });
    },
    registerHttpHandler: () => {},
    registerHttpRoute: (route: any) => {
      routes.push(route);
    },
    registerChannel: () => {},
    registerGatewayMethod: () => {},
    registerCli: () => {},
    registerService: () => {},
    registerProvider: () => {},
    registerCommand: () => {},
    resolvePath: (p: string) => p,
    getSkillSnapshot: () => ({
      prompt: "",
      skills: [{ name: "weather", primaryEnv: "WEATHER_KEY" }, { name: "github" }],
    }),
    on: (hookName: string, handler: Function) => {
      hooks.push({ events: hookName, handler });
    },
  };

  return { api, tools, hooks, logs, routes };
}

// ── Tests ──

describe("GET /mabos/api/capabilities", () => {
  let routes: RouteRegistration[];

  beforeEach(() => {
    const mock = createMockApi();
    register(mock.api as any);
    routes = mock.routes;
  });

  function findRoute(path: string): RouteRegistration | undefined {
    return routes.find((r) => r.path === path);
  }

  it("should register the /mabos/api/capabilities route", () => {
    const route = findRoute("/mabos/api/capabilities");
    assert.ok(route, "Route /mabos/api/capabilities should be registered");
    assert.equal(typeof route.handler, "function", "Handler should be a function");
  });

  it("returns unified capabilities JSON with correct shape", async () => {
    const route = findRoute("/mabos/api/capabilities");
    assert.ok(route, "Route should be registered");

    // Mock request (auth mode is "none" so no auth headers needed)
    const req = {
      headers: {},
      url: "/mabos/api/capabilities",
    };

    // Mock response that captures output
    let responseBody = "";
    const headers: Record<string, string> = {};
    const res = {
      statusCode: 200,
      setHeader: (key: string, value: string) => {
        headers[key] = value;
      },
      writeHead: (code: number, hdrs?: Record<string, string>) => {
        res.statusCode = code;
        if (hdrs) Object.assign(headers, hdrs);
      },
      end: (body?: string) => {
        responseBody = body ?? "";
      },
    };

    await route.handler(req, res);

    // Parse response — verify it is JSON
    assert.ok(
      (headers["Content-Type"] || "").startsWith("application/json"),
      "Should set JSON content type",
    );

    const data = JSON.parse(responseBody);

    // Verify top-level shape
    assert.ok(Array.isArray(data.mabosTools), "mabosTools should be an array");
    assert.ok(Array.isArray(data.openclawSkills), "openclawSkills should be an array");
    assert.equal(typeof data.totalCount, "number", "totalCount should be a number");
    assert.ok(data.generatedAt, "should have generatedAt timestamp");

    // Verify totalCount is the sum
    assert.equal(
      data.totalCount,
      data.mabosTools.length + data.openclawSkills.length,
      "totalCount should equal mabosTools.length + openclawSkills.length",
    );

    // Verify MABOS tools have required fields
    assert.ok(data.mabosTools.length > 0, "Should have at least one MABOS tool");
    for (const tool of data.mabosTools) {
      assert.equal(typeof tool.name, "string", "MABOS tool should have a name");
      assert.equal(tool.source, "mabos", "MABOS tool source should be mabos");
      assert.equal(typeof tool.category, "string", "MABOS tool should have a category");
    }

    // Verify OpenClaw skills from mock
    assert.equal(data.openclawSkills.length, 2, "Should have 2 OpenClaw skills from mock");

    const weatherSkill = data.openclawSkills.find((s: any) => s.name === "weather");
    assert.ok(weatherSkill, "Should include weather skill");
    assert.equal(weatherSkill.primaryEnv, "WEATHER_KEY", "weather skill should have primaryEnv");
    assert.equal(weatherSkill.source, "openclaw", "weather skill source should be openclaw");

    const githubSkill = data.openclawSkills.find((s: any) => s.name === "github");
    assert.ok(githubSkill, "Should include github skill");
    assert.equal(githubSkill.source, "openclaw", "github skill source should be openclaw");
  });

  it("includes known BDI tools with correct categories", async () => {
    const route = findRoute("/mabos/api/capabilities");
    assert.ok(route);

    const req = { headers: {}, url: "/mabos/api/capabilities" };
    let responseBody = "";
    const res = {
      statusCode: 200,
      setHeader: () => {},
      writeHead: () => {},
      end: (body?: string) => {
        responseBody = body ?? "";
      },
    };

    await route.handler(req, res);
    const data = JSON.parse(responseBody);

    // Check specific known tools and their categories
    const bdiCycle = data.mabosTools.find((t: any) => t.name === "bdi_cycle");
    assert.ok(bdiCycle, "Should include bdi_cycle tool");
    assert.equal(bdiCycle.category, "BDI Cognitive", "bdi_cycle should be in BDI Cognitive");

    const factAssert = data.mabosTools.find((t: any) => t.name === "fact_assert");
    assert.ok(factAssert, "Should include fact_assert tool");
    assert.equal(
      factAssert.category,
      "Reasoning & Knowledge",
      "fact_assert should be in Reasoning & Knowledge",
    );

    const businessCreate = data.mabosTools.find((t: any) => t.name === "business_create");
    assert.ok(businessCreate, "Should include business_create tool");
    assert.equal(
      businessCreate.category,
      "Business Operations",
      "business_create should be in Business Operations",
    );
  });

  it("gracefully handles getSkillSnapshot failure", async () => {
    // Create a mock where getSkillSnapshot throws
    const mock = createMockApi();
    (mock.api as any).getSkillSnapshot = () => {
      throw new Error("Skill snapshot unavailable");
    };
    register(mock.api as any);

    const route = mock.routes.find((r) => r.path === "/mabos/api/capabilities");
    assert.ok(route);

    const req = { headers: {}, url: "/mabos/api/capabilities" };
    let responseBody = "";
    const res = {
      statusCode: 200,
      setHeader: () => {},
      writeHead: () => {},
      end: (body?: string) => {
        responseBody = body ?? "";
      },
    };

    await route.handler(req, res);
    const data = JSON.parse(responseBody);

    // Should still return valid JSON with empty openclawSkills
    assert.ok(Array.isArray(data.mabosTools), "Should still have mabosTools");
    assert.ok(Array.isArray(data.openclawSkills), "Should still have openclawSkills array");
    assert.equal(data.openclawSkills.length, 0, "openclawSkills should be empty on failure");
    assert.equal(
      data.totalCount,
      data.mabosTools.length,
      "totalCount should only count MABOS tools",
    );
  });

  it("generatedAt is a valid ISO timestamp", async () => {
    const route = findRoute("/mabos/api/capabilities");
    assert.ok(route);

    const req = { headers: {}, url: "/mabos/api/capabilities" };
    let responseBody = "";
    const res = {
      statusCode: 200,
      setHeader: () => {},
      writeHead: () => {},
      end: (body?: string) => {
        responseBody = body ?? "";
      },
    };

    await route.handler(req, res);
    const data = JSON.parse(responseBody);

    const parsed = new Date(data.generatedAt);
    assert.ok(!isNaN(parsed.getTime()), "generatedAt should be a valid date");
  });
});
