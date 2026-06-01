import crypto from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import plugin, {
  AICS_DEVELOPER_MODE_CONTEXT_ALLOWLIST,
  AICS_DEVELOPER_MODE_CONTEXT_DENYLIST,
  verifyDijieExecutionPreflight,
} from "./index.js";

const keyPair = crypto.generateKeyPairSync("ed25519");
const privateKeyPem = keyPair.privateKey.export({ format: "pem", type: "pkcs8" }).toString();
const publicKeyPem = keyPair.publicKey.export({ format: "pem", type: "spki" }).toString();
const nowMs = 1_800_000_000_000;

function base64Url(value: Buffer | string): string {
  return Buffer.from(value).toString("base64url");
}

function createExecutionToken(overrides: Record<string, unknown> = {}) {
  const header = {
    alg: "EdDSA",
    typ: "JWT",
    kid: "dijie-execution-token-v1",
  };
  const payload = {
    iss: "dijie-cloud",
    typ: "dijie_execution",
    executionId: "exec_123",
    actorId: "cus_123",
    roleListingId: "prod_role_developer_agent",
    packageId: "pkg_developer_agent",
    packageVersion: "1.0.0",
    developerRef: "dev_001",
    listingOwnerRef: "seller_001",
    billingBeneficiaryRef: "dev_001",
    entitlementId: "ordgrp_123",
    deviceId: "device_123",
    workspaceRef: "workspace_123",
    localGatewayId: "gateway_123",
    scopes: ["role.build", "audit.write"],
    pricing: {
      kind: "one_time_authorization",
      authorizationFeeCents: 29900,
      currency: "CNY",
      platformFeeBps: 0,
      developerReceivableCents: 29900,
    },
    roleTokenPricing: {
      inputTokenCentsPerMillion: 120,
      outputTokenCentsPerMillion: 480,
      currency: "CNY",
      developerReceivableBps: 10000,
      platformFeeBps: 0,
    },
    iat: Math.floor(nowMs / 1000),
    exp: Math.floor(nowMs / 1000) + 300,
    ...overrides,
  };
  const signingInput = `${base64Url(JSON.stringify(header))}.${base64Url(JSON.stringify(payload))}`;
  return `${signingInput}.${base64Url(crypto.sign(null, Buffer.from(signingInput), privateKeyPem))}`;
}

function params(overrides: Record<string, unknown> = {}) {
  return {
    executionToken: createExecutionToken(),
    roleListingId: "prod_role_developer_agent",
    entitlementId: "ordgrp_123",
    deviceId: "device_123",
    workspaceRef: "workspace_123",
    localGatewayId: "gateway_123",
    nowMs: nowMs + 1_000,
    ...overrides,
  };
}

function toolParams(overrides: Record<string, unknown> = {}) {
  return {
    request_zh: "创建一个主系统岗位包生成岗位包",
    confirm_brief: true,
    role_build_brief_json: JSON.stringify({
      name: "主系统岗位包生成",
      target_user: "迭界AI开发者",
      deliverables: ["role_package/manifest.json"],
    }),
    execution_token: createExecutionToken(),
    role_listing_id: "prod_role_developer_agent",
    entitlement_id: "ordgrp_123",
    device_id: "device_123",
    workspace_ref: "workspace_123",
    local_gateway_id: "gateway_123",
    ...overrides,
  };
}

function createFakeLocalExecutorBinary(
  options: {
    files?: Record<string, string>;
    exitCode?: number;
    capturePrompt?: boolean;
  } = {},
) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "dijie-fake-local-executor-"));
  const binary = path.join(dir, "local-executor");
  const files = options.files ?? {
    "role_package/manifest.json": JSON.stringify({ name: "role-builder" }, null, 2),
    "role_package/listing.md": "# 主系统岗位包生成\n",
    "role_package/README.md": "# Role package\n",
    "role_package/adapters/openclaw-adapter.ts": "export const adapter = 'openclaw';\n",
    "role_package/validation/smoke-test.md": "# Smoke test\n",
  };
  writeFileSync(
    binary,
    [
      "#!/usr/bin/env node",
      "const path = require('node:path');",
      "const fs = require('node:fs');",
      `const files = ${JSON.stringify(files)};`,
      "const forbiddenEnvKeys = ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'DIJIE_SECRET', 'PROVIDER_AUTH'];",
      "let stdin = '';",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', (chunk) => { stdin += chunk; });",
      "process.stdin.on('end', () => {",
      options.capturePrompt
        ? "  fs.writeFileSync('.captured-local-executor-prompt.md', stdin);"
        : "",
      "  const leakedKey = forbiddenEnvKeys.find((key) => process.env[key]);",
      "  if (leakedKey) {",
      "    fs.mkdirSync('role_package', { recursive: true });",
      "    fs.writeFileSync('role_package/secret-leak.txt', leakedKey);",
      "    process.exitCode = 44;",
      "    return;",
      "  }",
      "  for (const [filePath, content] of Object.entries(files)) {",
      "    fs.mkdirSync(path.dirname(filePath), { recursive: true });",
      "    fs.writeFileSync(filePath, content);",
      "  }",
      "  console.log(JSON.stringify({ type: 'fake-local-executor-event', receivedBrief: stdin.includes('RoleBuildBrief') }));",
      `  process.exitCode = ${options.exitCode ?? 0};`,
      "});",
      "",
    ].join("\n"),
  );
  chmodSync(binary, 0o755);
  return binary;
}

function createFakeNativeRuntime(options: { files?: Record<string, string> } = {}) {
  const runEmbeddedAgent = vi.fn(async (params: { workspaceDir: string; prompt: string }) => {
    const files = options.files ?? {
      "role_package/manifest.json": JSON.stringify({ name: "native-role-builder" }, null, 2),
      "role_package/listing.md": "# Native role package\n",
      "role_package/README.md": "# Role package\n",
      "role_package/adapters/openclaw-native-adapter.ts":
        "export const adapter = 'openclaw-native';\n",
      "role_package/validation/smoke-test.md": "# Smoke test\n",
    };
    for (const [filePath, content] of Object.entries(files)) {
      const absolutePath = path.join(params.workspaceDir, filePath);
      mkdirSync(path.dirname(absolutePath), { recursive: true });
      writeFileSync(absolutePath, content);
    }
    return {
      payloads: [
        {
          text: JSON.stringify({
            type: "fake-openclaw-native-event",
            receivedBrief: params.prompt.includes("RoleBuildBrief"),
          }),
        },
      ],
      meta: {
        durationMs: 25,
        finalAssistantVisibleText: "Native role package generated.",
        agentMeta: {
          usage: {
            input: 1200,
            output: 300,
          },
        },
        executionTrace: {
          attempts: [{ provider: "openclaw", model: "native", result: "success" }],
        },
      },
    };
  });

  return {
    runtime: {
      agent: {
        runEmbeddedAgent,
      },
    },
    runEmbeddedAgent,
  };
}

function registerRoleBuilder(
  pluginConfig: Record<string, unknown>,
  apiOverrides: Record<string, unknown> = {},
) {
  const registerTool = vi.fn();
  const commandConfig =
    typeof pluginConfig.localExecutorCommand === "string" ||
    typeof pluginConfig.codexBinary === "string"
      ? {}
      : { localExecutorCommand: createFakeLocalExecutorBinary() };
  plugin.register({
    pluginConfig: {
      allowWrites: true,
      executionTokenPublicKeyPem: publicKeyPem,
      rolePackageOutputRoot: mkdtempSync(path.join(os.tmpdir(), "dijie-role-output-")),
      ...commandConfig,
      ...pluginConfig,
    },
    registerGatewayMethod: vi.fn(),
    registerTool,
    ...apiOverrides,
  } as never);
  return registerTool.mock.calls
    .map((call) => call[0])
    .find((tool) => tool.name === "dijie_role_builder");
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Dijie execution preflight", () => {
  it("accepts a signed execution token that matches local context", () => {
    expect(
      verifyDijieExecutionPreflight({ executionTokenPublicKeyPem: publicKeyPem }, params()),
    ).toMatchObject({
      ok: true,
      executionId: "exec_123",
      roleListingId: "prod_role_developer_agent",
      packageId: "pkg_developer_agent",
      packageVersion: "1.0.0",
      developerRef: "dev_001",
      billingBeneficiaryRef: "dev_001",
      pricing: { kind: "one_time_authorization" },
      roleTokenPricing: {
        inputTokenCentsPerMillion: 120,
        outputTokenCentsPerMillion: 480,
        developerReceivableBps: 10000,
        platformFeeBps: 0,
      },
      scopes: ["role.build", "audit.write"],
    });
  });

  it("rejects signed execution tokens missing role token pricing", () => {
    expect(
      verifyDijieExecutionPreflight(
        { executionTokenPublicKeyPem: publicKeyPem },
        params({ executionToken: createExecutionToken({ roleTokenPricing: undefined }) }),
      ),
    ).toEqual({
      ok: false,
      code: "invalid_execution_token",
      error: "Invalid Dijie execution token claims.",
    });
  });

  it("rejects signed execution tokens with invalid role token pricing", () => {
    expect(
      verifyDijieExecutionPreflight(
        { executionTokenPublicKeyPem: publicKeyPem },
        params({
          executionToken: createExecutionToken({
            roleTokenPricing: {
              inputTokenCentsPerMillion: 120,
              outputTokenCentsPerMillion: -1,
              currency: "CNY",
              developerReceivableBps: 10000,
              platformFeeBps: 0,
            },
          }),
        }),
      ),
    ).toEqual({
      ok: false,
      code: "invalid_execution_token",
      error: "Invalid Dijie execution token claims.",
    });

    expect(
      verifyDijieExecutionPreflight(
        { executionTokenPublicKeyPem: publicKeyPem },
        params({
          executionToken: createExecutionToken({
            roleTokenPricing: {
              inputTokenCentsPerMillion: 120,
              outputTokenCentsPerMillion: 480,
              currency: "CNY",
              developerReceivableBps: 9500,
              platformFeeBps: 500,
            },
          }),
        }),
      ),
    ).toEqual({
      ok: false,
      code: "invalid_execution_token",
      error: "Invalid Dijie execution token claims.",
    });
  });

  it("rejects missing local public key config", () => {
    expect(verifyDijieExecutionPreflight({}, params())).toMatchObject({
      ok: false,
      code: "invalid_execution_token",
    });
  });

  it("rejects token context mismatches", () => {
    expect(
      verifyDijieExecutionPreflight(
        { executionTokenPublicKeyPem: publicKeyPem },
        params({ deviceId: "wrong_device" }),
      ),
    ).toEqual({
      ok: false,
      code: "context_mismatch",
      error: "Execution token deviceId does not match local request context.",
    });
  });

  it("rejects tokens without role.build scope", () => {
    expect(
      verifyDijieExecutionPreflight(
        { executionTokenPublicKeyPem: publicKeyPem },
        params({ executionToken: createExecutionToken({ scopes: ["audit.write"] }) }),
      ),
    ).toEqual({
      ok: false,
      code: "missing_scope",
      error: "Execution token does not include role.build scope.",
    });
  });

  it("registers the gateway preflight and role-builder run methods", async () => {
    const registerGatewayMethod = vi.fn();
    const registerTool = vi.fn();

    plugin.register({
      pluginConfig: { executionTokenPublicKeyPem: publicKeyPem },
      registerGatewayMethod,
      registerTool,
    } as never);

    expect(registerGatewayMethod).toHaveBeenCalledWith(
      "dijie.execution.preflight",
      expect.any(Function),
      { scope: "operator.write" },
    );
    expect(registerGatewayMethod).toHaveBeenCalledWith(
      "dijie.roleBuilder.run",
      expect.any(Function),
      { scope: "operator.write" },
    );
    expect(registerGatewayMethod).toHaveBeenCalledWith(
      "dijie.executionToken.request",
      expect.any(Function),
      { scope: "operator.write" },
    );
    expect(registerGatewayMethod).toHaveBeenCalledWith(
      "dijie.executionAudit.read",
      expect.any(Function),
      { scope: "operator.read" },
    );
    expect(registerGatewayMethod).toHaveBeenCalledWith(
      "dijie.marketplace.roles.list",
      expect.any(Function),
      { scope: "operator.read" },
    );
    expect(registerTool).toHaveBeenCalledTimes(5);

    const handler = registerGatewayMethod.mock.calls.find(
      (call) => call[0] === "dijie.roleBuilder.run",
    )?.[1];
    const response = await handler({ params: toolParams(), respond: vi.fn() });
    expect(response).toMatchObject({
      ok: false,
      summary: "迭界AI role-builder request failed before local execution could complete",
      error: "confirm_brief requires aics.allowWrites=true in OpenClaw config",
    });
  });

  it("requests cloud execution tokens without echoing the cloud access token", async () => {
    const registerGatewayMethod = vi.fn();
    const registerTool = vi.fn();
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.headers).toMatchObject({
        authorization: "Bearer cloud_customer_token",
        "content-type": "application/json",
      });
      expect(JSON.parse(String(init?.body))).toEqual({
        roleListingId: "prod_role_developer_agent",
        entitlementId: "ordgrp_123",
        deviceId: "device_123",
        workspaceRef: "workspace_123",
        localGatewayId: "gateway_123",
      });
      return new Response(
        JSON.stringify({
          ok: true,
          grant: {
            executionId: "exec_cloud_123",
            roleListingId: "prod_role_developer_agent",
            entitlementId: "ordgrp_123",
            deviceId: "device_123",
            workspaceRef: "workspace_123",
            localGatewayId: "gateway_123",
            token: "short_lived_execution_token",
            issuedAt: "2026-05-31T08:00:00.000Z",
            expiresAt: "2026-05-31T08:05:00.000Z",
            pricing: {
              kind: "one_time_authorization",
              authorizationFeeCents: 29900,
              currency: "CNY",
              platformFeeBps: 0,
              developerReceivableCents: 29900,
            },
            roleTokenPricing: {
              inputTokenCentsPerMillion: 120,
              outputTokenCentsPerMillion: 480,
              currency: "CNY",
              developerReceivableBps: 10000,
              platformFeeBps: 0,
            },
            scopes: ["role.execute", "audit.write"],
          },
        }),
        { status: 200 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    plugin.register({
      pluginConfig: {
        cloudBaseUrl: "https://dijie-cloud.test",
      },
      registerGatewayMethod,
      registerTool,
    } as never);

    const handler = registerGatewayMethod.mock.calls.find(
      (call) => call[0] === "dijie.executionToken.request",
    )?.[1];
    const response = await handler({
      params: {
        cloud_access_token: "cloud_customer_token",
        role_listing_id: "prod_role_developer_agent",
        entitlement_id: "ordgrp_123",
        device_id: "device_123",
        workspace_ref: "workspace_123",
        local_gateway_id: "gateway_123",
      },
      respond: vi.fn(),
    });

    expect(fetchMock.mock.calls[0][0]).toBe("https://dijie-cloud.test/dijie/execution-token");
    expect(response).toMatchObject({
      ok: true,
      summary: "迭界AI cloud execution token issued",
      grant: {
        executionId: "exec_cloud_123",
        token: "short_lived_execution_token",
        roleTokenPricing: {
          inputTokenCentsPerMillion: 120,
          outputTokenCentsPerMillion: 480,
          developerReceivableBps: 10000,
          platformFeeBps: 0,
        },
      },
    });
    expect(JSON.stringify(response)).not.toContain("cloud_customer_token");
  });

  it("fails execution token requests closed when the cloud grant is malformed", async () => {
    const registerGatewayMethod = vi.fn();
    const registerTool = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              ok: true,
              grant: {
                executionId: "exec_cloud_123",
                roleListingId: "prod_role_developer_agent",
                entitlementId: "ordgrp_123",
                deviceId: "device_123",
                workspaceRef: "workspace_123",
                localGatewayId: "gateway_123",
                token: "short_lived_execution_token",
                pricing: {
                  kind: "one_time_authorization",
                  authorizationFeeCents: 29900,
                  currency: "CNY",
                  platformFeeBps: 0,
                  developerReceivableCents: 29900,
                },
                scopes: ["role.execute", "audit.write"],
              },
            }),
            { status: 200 },
          ),
      ),
    );

    plugin.register({
      pluginConfig: {
        cloudBaseUrl: "https://dijie-cloud.test",
      },
      registerGatewayMethod,
      registerTool,
    } as never);

    const handler = registerGatewayMethod.mock.calls.find(
      (call) => call[0] === "dijie.executionToken.request",
    )?.[1];
    const response = await handler({
      params: {
        cloud_access_token: "cloud_customer_token",
        role_listing_id: "prod_role_developer_agent",
        entitlement_id: "ordgrp_123",
        device_id: "device_123",
        workspace_ref: "workspace_123",
        local_gateway_id: "gateway_123",
      },
      respond: vi.fn(),
    });

    expect(response).toMatchObject({
      ok: false,
      summary: "迭界AI cloud execution token response did not include a valid grant",
      statusCode: 200,
    });
    expect(JSON.stringify(response)).not.toContain("short_lived_execution_token");
    expect(JSON.stringify(response)).not.toContain("cloud_customer_token");
  });

  it("lists installed marketplace roles without echoing the cloud access token", async () => {
    const registerGatewayMethod = vi.fn();
    const registerTool = vi.fn();
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.method).toBe("GET");
      expect(init?.headers).toMatchObject({
        authorization: "Bearer cloud_customer_token",
        accept: "application/json",
      });
      return new Response(
        JSON.stringify({
          ok: true,
          roles: [
            {
              id: "role_quality_agent",
              title: "客服质检岗位",
              status: "installed",
              note: "cloud_customer_token must be redacted if echoed",
            },
          ],
        }),
        { status: 200 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    plugin.register({
      pluginConfig: {
        cloudBaseUrl: "https://dijie-cloud.test",
      },
      registerGatewayMethod,
      registerTool,
    } as never);

    const handler = registerGatewayMethod.mock.calls.find(
      (call) => call[0] === "dijie.marketplace.roles.list",
    )?.[1];
    const response = await handler({
      params: {
        cloud_access_token: "cloud_customer_token",
        workspace_ref: "workspace_123",
        device_id: "device_123",
      },
      respond: vi.fn(),
    });

    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://dijie-cloud.test/dijie/my-roles?workspaceRef=workspace_123&deviceId=device_123",
    );
    expect(response).toMatchObject({
      ok: true,
      summary: "迭界AI marketplace installed roles read completed",
      source: "cloud",
      roles: [
        {
          id: "role_quality_agent",
          title: "客服质检岗位",
          note: "[redacted_cloud_access_token] must be redacted if echoed",
        },
      ],
    });
    expect(JSON.stringify(response)).not.toContain("cloud_customer_token");
  });

  it("fails marketplace role listing clearly when the marketplace URL is not configured", async () => {
    const registerGatewayMethod = vi.fn();
    const registerTool = vi.fn();

    plugin.register({
      pluginConfig: {},
      registerGatewayMethod,
      registerTool,
    } as never);

    const handler = registerGatewayMethod.mock.calls.find(
      (call) => call[0] === "dijie.marketplace.roles.list",
    )?.[1];
    const response = await handler({
      params: {
        cloud_access_token: "cloud_customer_token",
      },
      respond: vi.fn(),
    });

    expect(response).toMatchObject({
      ok: false,
      summary:
        "迭界AI marketplace installed roles read failed before marketplace read could complete",
      error:
        "cloudMarketplaceInstalledRolesUrl or cloudBaseUrl is required before reading installed roles.",
    });
    expect(JSON.stringify(response)).not.toContain("cloud_customer_token");
  });

  it("does not fake marketplace role listing success when the cloud response is malformed", async () => {
    const registerGatewayMethod = vi.fn();
    const registerTool = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })),
    );

    plugin.register({
      pluginConfig: {
        cloudBaseUrl: "https://dijie-cloud.test",
      },
      registerGatewayMethod,
      registerTool,
    } as never);

    const handler = registerGatewayMethod.mock.calls.find(
      (call) => call[0] === "dijie.marketplace.roles.list",
    )?.[1];
    const response = await handler({
      params: {
        cloud_access_token: "cloud_customer_token",
      },
      respond: vi.fn(),
    });

    expect(response).toMatchObject({
      ok: false,
      summary: "迭界AI marketplace installed roles response did not include roles",
      statusCode: 200,
    });
  });

  it("reads cloud execution audits without echoing the cloud access token", async () => {
    const registerGatewayMethod = vi.fn();
    const registerTool = vi.fn();
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.method).toBe("GET");
      expect(init?.headers).toMatchObject({
        authorization: "Bearer cloud_customer_token",
        accept: "application/json",
      });
      return new Response(
        JSON.stringify({
          ok: true,
          execution: {
            executionId: "exec_cloud_123",
            status: "completed",
            auditSummary: {
              roleListingId: "prod_role_developer_agent",
              note: "cloud_customer_token must be redacted if cloud echoes it",
            },
            authorization: "Bearer cloud_customer_token",
          },
        }),
        { status: 200 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    plugin.register({
      pluginConfig: {
        cloudBaseUrl: "https://dijie-cloud.test",
      },
      registerGatewayMethod,
      registerTool,
    } as never);

    const handler = registerGatewayMethod.mock.calls.find(
      (call) => call[0] === "dijie.executionAudit.read",
    )?.[1];
    const response = await handler({
      params: {
        cloud_access_token: "cloud_customer_token",
        execution_id: "exec_cloud_123",
      },
      respond: vi.fn(),
    });

    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://dijie-cloud.test/dijie/executions/exec_cloud_123",
    );
    expect(response).toMatchObject({
      ok: true,
      summary: "迭界AI cloud execution audit read completed",
      execution: {
        executionId: "exec_cloud_123",
        status: "completed",
        authorization: "[redacted_cloud_access_token]",
      },
    });
    expect(JSON.stringify(response)).not.toContain("cloud_customer_token");
  });

  it("redacts cloud access tokens from rejected cloud execution audit reads", async () => {
    const registerGatewayMethod = vi.fn();
    const registerTool = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              ok: false,
              error: "cloud_customer_token is not authorized for this execution",
            }),
            { status: 403 },
          ),
      ),
    );

    plugin.register({
      pluginConfig: {
        cloudExecutionReadUrl: "https://dijie-cloud.test/dijie/executions",
      },
      registerGatewayMethod,
      registerTool,
    } as never);

    const handler = registerGatewayMethod.mock.calls.find(
      (call) => call[0] === "dijie.executionAudit.read",
    )?.[1];
    const response = await handler({
      params: {
        cloud_access_token: "cloud_customer_token",
        execution_id: "exec_cloud_123",
      },
      respond: vi.fn(),
    });

    expect(response).toMatchObject({
      ok: false,
      summary: "迭界AI cloud execution audit read was rejected",
      statusCode: 403,
      error: "[redacted_cloud_access_token] is not authorized for this execution",
    });
    expect(JSON.stringify(response)).not.toContain("cloud_customer_token");
  });

  it("runs confirmed role-builder requests through the OpenClaw main-system local executor after preflight", async () => {
    const registerGatewayMethod = vi.fn();
    const registerTool = vi.fn();
    const outputRoot = mkdtempSync(path.join(os.tmpdir(), "dijie-role-output-"));
    const fakeExecutor = createFakeLocalExecutorBinary();

    plugin.register({
      pluginConfig: {
        allowWrites: true,
        executionTokenPublicKeyPem: publicKeyPem,
        rolePackageOutputRoot: outputRoot,
        localExecutorCommand: fakeExecutor,
      },
      registerGatewayMethod,
      registerTool,
    } as never);

    const roleBuilderTool = registerTool.mock.calls
      .map((call) => call[0])
      .find((tool) => tool.name === "dijie_role_builder");
    const result = await roleBuilderTool.execute("call-1", toolParams());

    expect(result.details).toMatchObject({
      ok: true,
      summary: "迭界AI role-builder OpenClaw main-system local execution completed and validated",
      confirmed: true,
      executionId: "exec_123",
      roleListingId: "prod_role_developer_agent",
      packageId: "pkg_developer_agent",
      packageVersion: "1.0.0",
      developerRef: "dev_001",
      listingOwnerRef: "seller_001",
      billingBeneficiaryRef: "dev_001",
      entitlementId: "ordgrp_123",
      deviceId: "device_123",
      workspaceRef: "workspace_123",
      localGatewayId: "gateway_123",
      status: "completed",
      roleTokenPricing: {
        inputTokenCentsPerMillion: 120,
        outputTokenCentsPerMillion: 480,
        developerReceivableBps: 10000,
        platformFeeBps: 0,
      },
      modelProxyUsage: {
        requestCount: 0,
        inputTokens: 0,
        outputTokens: 0,
      },
      rolePackageValidation: { ok: true, errors: [] },
      auditUpload: { ok: true, skipped: true, required: false },
      toolUsage: {
        shellCommands: 1,
        testsRun: 1,
        filesRead: 0,
        filesChanged: 5,
      },
      result: {
        executionId: "exec_123",
        roleListingId: "prod_role_developer_agent",
        status: "completed",
        roleTokenPricing: {
          inputTokenCentsPerMillion: 120,
          outputTokenCentsPerMillion: 480,
          developerReceivableBps: 10000,
          platformFeeBps: 0,
        },
        modelProxyUsage: {
          requestCount: 0,
          inputTokens: 0,
          outputTokens: 0,
        },
        changedFiles: [
          "role_package/README.md",
          "role_package/adapters/openclaw-adapter.ts",
          "role_package/listing.md",
          "role_package/manifest.json",
          "role_package/validation/smoke-test.md",
        ],
      },
    });
    expect(existsSync(path.join(outputRoot, "role_package", "manifest.json"))).toBe(true);
    expect(result.details.localExecutor.command[0]).toBe(fakeExecutor);
  });

  it("uses OpenClaw-native runEmbeddedAgent when the runtime executor is available", async () => {
    const registerGatewayMethod = vi.fn();
    const registerTool = vi.fn();
    const outputRoot = mkdtempSync(path.join(os.tmpdir(), "dijie-role-output-"));
    const { runtime, runEmbeddedAgent } = createFakeNativeRuntime();

    plugin.register({
      pluginConfig: {
        allowWrites: true,
        executionTokenPublicKeyPem: publicKeyPem,
        rolePackageOutputRoot: outputRoot,
      },
      config: {},
      runtime,
      registerGatewayMethod,
      registerTool,
    } as never);

    const roleBuilderTool = registerTool.mock.calls
      .map((call) => call[0])
      .find((tool) => tool.name === "dijie_role_builder");
    const result = await roleBuilderTool.execute("call-1", toolParams());

    expect(runEmbeddedAgent).toHaveBeenCalledTimes(1);
    expect(runEmbeddedAgent.mock.calls[0][0]).toMatchObject({
      workspaceDir: realpathSync(outputRoot),
      cwd: realpathSync(outputRoot),
      disableMessageTool: true,
      cleanupBundleMcpOnRunEnd: true,
    });
    expect(result.details).toMatchObject({
      ok: true,
      status: "completed",
      executionEngine: "openclaw-native",
      modelProxyUsage: {
        requestCount: 1,
        inputTokens: 1200,
        outputTokens: 300,
      },
      localExecutor: {
        command: ["openclaw-native", "runEmbeddedAgent"],
        exitCode: 0,
        modelProxyUsage: {
          requestCount: 1,
          inputTokens: 1200,
          outputTokens: 300,
        },
      },
      result: {
        modelProxyUsage: {
          requestCount: 1,
          inputTokens: 1200,
          outputTokens: 300,
        },
        changedFiles: [
          "role_package/README.md",
          "role_package/adapters/openclaw-native-adapter.ts",
          "role_package/listing.md",
          "role_package/manifest.json",
          "role_package/validation/smoke-test.md",
        ],
      },
    });
    const prompt = runEmbeddedAgent.mock.calls[0]?.[0]?.prompt ?? "";
    expect(prompt).toContain("开发者只需要用自然语言讲业务逻辑和业务流程");
    expect(prompt).toContain(
      "输入、输出、规则、验收标准、岗位包结构、协议映射、验证材料和上传标准都是平台职责",
    );
    expect(prompt).toContain(
      "不要让开发者定义、填写或逐项确认输入、输出、规则、验收标准这些平台标准",
    );
    expect(prompt).toContain("不要要求开发者理解 execution token");
    expect(prompt).toContain("平台接口、协议、鉴权、审计、计费");
    expect(prompt).toContain("role_package/manifest.json");
    expect(prompt).not.toContain("exec_123");
    expect(prompt).not.toContain("cus_123");
    expect(prompt).not.toContain("ordgrp_123");
    expect(prompt).not.toContain("pricing:");
  });

  it("keeps developer-mode prompt context on the allowlisted local boundary", async () => {
    expect(AICS_DEVELOPER_MODE_CONTEXT_ALLOWLIST).toContain("natural-language business logic");
    expect(AICS_DEVELOPER_MODE_CONTEXT_ALLOWLIST).toContain(
      "isolated local workspace with relative role_package/ paths",
    );
    expect(AICS_DEVELOPER_MODE_CONTEXT_DENYLIST).toEqual(
      expect.arrayContaining([
        "executionId",
        "actorId",
        "entitlementId",
        "cloud bearer tokens",
        "raw execution tokens",
        "provider key names or values",
        "ordinary user conversation history",
        "private memories",
      ]),
    );

    const registerTool = vi.fn();
    const outputRoot = mkdtempSync(path.join(os.tmpdir(), "dijie-role-output-"));
    const { runtime, runEmbeddedAgent } = createFakeNativeRuntime();

    plugin.register({
      pluginConfig: {
        allowWrites: true,
        executionTokenPublicKeyPem: publicKeyPem,
        rolePackageOutputRoot: outputRoot,
      },
      config: {},
      runtime,
      registerGatewayMethod: vi.fn(),
      registerTool,
    } as never);

    const roleBuilderTool = registerTool.mock.calls
      .map((call) => call[0])
      .find((tool) => tool.name === "dijie_role_builder");
    await roleBuilderTool.execute(
      "call-1",
      toolParams({
        request_zh:
          "做一个退款分诊岗位。误贴的 Bearer cloud_bearer_value_12345 和 OPENAI_API_KEY 不应进入本地上下文。",
        role_build_brief_json: JSON.stringify({
          name: "退款分诊岗位",
          businessGoal: "按业务逻辑判断退款材料是否齐全",
          executionId: "exec_brief_leak",
          actorId: "actor_brief_leak",
          entitlementId: "entitlement_brief_leak",
          pricingSnapshot: { authorizationFeeCents: 29900 },
          reviewState: "approved",
          settlementState: "pending",
          privateMemory: "普通用户私有记忆",
          notes: "provider value sk-testsecretvalue1234567890 should be redacted",
        }),
      }),
    );

    const prompt = runEmbeddedAgent.mock.calls[0]?.[0]?.prompt ?? "";
    expect(prompt).toContain("退款分诊岗位");
    expect(prompt).toContain("按业务逻辑判断退款材料是否齐全");
    expect(prompt).toContain("role_package/");
    expect(prompt).not.toContain(outputRoot);
    expect(prompt).not.toContain("exec_123");
    expect(prompt).not.toContain("ordgrp_123");
    expect(prompt).not.toContain("exec_brief_leak");
    expect(prompt).not.toContain("actor_brief_leak");
    expect(prompt).not.toContain("entitlement_brief_leak");
    expect(prompt).not.toContain("authorizationFeeCents");
    expect(prompt).not.toContain("reviewState");
    expect(prompt).not.toContain("settlementState");
    expect(prompt).not.toContain("普通用户私有记忆");
    expect(prompt).not.toContain("OPENAI_API_KEY");
    expect(prompt).not.toContain("sk-testsecretvalue1234567890");
    expect(prompt).not.toContain("Bearer cloud_bearer_value_12345");
  });

  it("rejects role_package artifacts that leak local-kernel forbidden material", async () => {
    const outputRoot = mkdtempSync(path.join(os.tmpdir(), "dijie-role-output-"));
    const roleBuilderTool = registerRoleBuilder({
      rolePackageOutputRoot: outputRoot,
      localExecutorCommand: createFakeLocalExecutorBinary({
        files: {
          "role_package/manifest.json": JSON.stringify(
            {
              name: "leaky-role-builder",
              executionId: "exec_123",
              roleListingId: "role_123",
              order: { id: "ord_123" },
              orderGroup: { id: "ordgrp_123" },
              wallet: { balance: 100 },
              walletState: "wallet_123",
              pricingSnapshot: {
                roleTokenPricing: "internal settlement snapshot",
              },
              secretsRequired: ["OPENAI_API_KEY"],
            },
            null,
            2,
          ),
          "role_package/listing.md": "# Leaky role package\nBearer cloud_bearer_value_12345\n",
          "role_package/README.md": `# Role package\nGenerated at ${outputRoot}\n`,
          "role_package/adapters/openclaw-adapter.ts":
            "export const apiKey = 'sk-testsecretvalue1234567890';\n",
          "role_package/validation/smoke-test.md": "# Smoke test\n",
        },
      }),
    });

    const result = await roleBuilderTool.execute("call-1", toolParams());

    expect(result.details).toMatchObject({
      ok: false,
      status: "failed",
      summary: "迭界AI role-builder local executor failed or produced an invalid role_package",
      rolePackageValidation: { ok: false },
    });
    expect(result.details.rolePackageValidation.errors).toEqual(
      expect.arrayContaining([
        "role_package/manifest.json contains backend-only id or raw execution token",
        "role_package/manifest.json contains provider key name or value",
        "role_package/manifest.json contains secret or token field",
        "role_package/manifest.json contains backend-only field executionId",
        "role_package/manifest.json contains backend-only field roleListingId",
        "role_package/manifest.json contains backend-only field order",
        "role_package/manifest.json contains backend-only field orderGroup",
        "role_package/manifest.json contains backend-only field wallet",
        "role_package/listing.md contains cloud bearer token",
        "role_package/README.md contains local absolute path",
        "role_package/adapters/openclaw-adapter.ts contains provider key name or value",
        "role_package/adapters/openclaw-adapter.ts contains secret or token field",
      ]),
    );
    expect(result.details.result.error).toContain("role_package validation failed");
  });

  it("applies role_package forbidden material scanning to OpenClaw-native output", async () => {
    const registerTool = vi.fn();
    const outputRoot = mkdtempSync(path.join(os.tmpdir(), "dijie-role-output-"));
    const { runtime } = createFakeNativeRuntime({
      files: {
        "role_package/manifest.json": JSON.stringify({ name: "native-leaky-role" }, null, 2),
        "role_package/listing.md": "# Native leaky role\n",
        "role_package/README.md": "Execution leaked from actorId: cus_123\n",
        "role_package/adapters/openclaw-native-adapter.ts":
          "export const adapter = 'openclaw-native';\n",
        "role_package/validation/smoke-test.md": "# Smoke test\n",
      },
    });

    plugin.register({
      pluginConfig: {
        allowWrites: true,
        executionTokenPublicKeyPem: publicKeyPem,
        rolePackageOutputRoot: outputRoot,
        localExecutorMode: "native",
      },
      config: {},
      runtime,
      registerGatewayMethod: vi.fn(),
      registerTool,
    } as never);

    const roleBuilderTool = registerTool.mock.calls
      .map((call) => call[0])
      .find((tool) => tool.name === "dijie_role_builder");
    const result = await roleBuilderTool.execute("call-1", toolParams());

    expect(result.details).toMatchObject({
      ok: false,
      status: "failed",
      executionEngine: "openclaw-native",
      rolePackageValidation: { ok: false },
    });
    expect(result.details.rolePackageValidation.errors).toEqual(
      expect.arrayContaining([
        "role_package/README.md contains backend-only id or raw execution token",
      ]),
    );
  });

  it("uses the same developer-mode prompt boundary for native and subprocess executors", async () => {
    const nativeRegisterTool = vi.fn();
    const nativeOutputRoot = mkdtempSync(path.join(os.tmpdir(), "dijie-role-output-"));
    const { runtime, runEmbeddedAgent } = createFakeNativeRuntime();

    plugin.register({
      pluginConfig: {
        allowWrites: true,
        executionTokenPublicKeyPem: publicKeyPem,
        rolePackageOutputRoot: nativeOutputRoot,
        localExecutorMode: "native",
      },
      config: {},
      runtime,
      registerGatewayMethod: vi.fn(),
      registerTool: nativeRegisterTool,
    } as never);

    const nativeRoleBuilderTool = nativeRegisterTool.mock.calls
      .map((call) => call[0])
      .find((tool) => tool.name === "dijie_role_builder");
    await nativeRoleBuilderTool.execute("native-call", toolParams());
    const nativePrompt = runEmbeddedAgent.mock.calls[0]?.[0]?.prompt ?? "";

    const subprocessOutputRoot = mkdtempSync(path.join(os.tmpdir(), "dijie-role-output-"));
    const subprocessRoleBuilderTool = registerRoleBuilder({
      rolePackageOutputRoot: subprocessOutputRoot,
      localExecutorMode: "subprocess",
      localExecutorCommand: createFakeLocalExecutorBinary({ capturePrompt: true }),
    });
    await subprocessRoleBuilderTool.execute("subprocess-call", toolParams());
    const subprocessPrompt = readFileSync(
      path.join(subprocessOutputRoot, ".captured-local-executor-prompt.md"),
      "utf8",
    );

    for (const prompt of [nativePrompt, subprocessPrompt]) {
      expect(prompt).toContain("开发者模式上下文 allowlist");
      expect(prompt).toContain("开发者只需要用自然语言讲业务逻辑和业务流程");
      expect(prompt).toContain("role_package/manifest.json");
      expect(prompt).toContain("隔离 workspace");
      expect(prompt).not.toContain("exec_123");
      expect(prompt).not.toContain("cus_123");
      expect(prompt).not.toContain("ordgrp_123");
      expect(prompt).not.toContain(nativeOutputRoot);
      expect(prompt).not.toContain(subprocessOutputRoot);
    }
  });

  it("honors generic local executor args with workspace placeholders", async () => {
    const outputRoot = mkdtempSync(path.join(os.tmpdir(), "dijie-role-output-"));
    const workspaceRoot = realpathSync(outputRoot);
    const roleBuilderTool = registerRoleBuilder({
      rolePackageOutputRoot: outputRoot,
      localExecutorCommand: createFakeLocalExecutorBinary(),
      localExecutorArgs: ["--workspace", "{outputRoot}", "--last-message", "{lastMessagePath}"],
    });

    const result = await roleBuilderTool.execute("call-1", toolParams());

    expect(result.details).toMatchObject({
      ok: true,
      status: "completed",
      localExecutor: {
        command: [
          expect.any(String),
          "--workspace",
          workspaceRoot,
          "--last-message",
          path.join(workspaceRoot, ".dijie_local_executor_last_message.md"),
        ],
      },
    });
  });

  it("keeps legacy binary config compatibility for the temporary subprocess adapter", async () => {
    const outputRoot = mkdtempSync(path.join(os.tmpdir(), "dijie-role-output-"));
    const fakeExecutor = createFakeLocalExecutorBinary();
    const roleBuilderTool = registerRoleBuilder({
      rolePackageOutputRoot: outputRoot,
      codexBinary: fakeExecutor,
    });

    const result = await roleBuilderTool.execute("call-1", toolParams());

    expect(result.details).toMatchObject({
      ok: true,
      status: "completed",
    });
    expect(result.details.localExecutor.command[0]).toBe(fakeExecutor);
  });

  it("does not pass raw provider secrets into the local executor subprocess environment", async () => {
    const previousOpenAiKey = process.env.OPENAI_API_KEY;
    const previousDijieSecret = process.env.DIJIE_SECRET;
    process.env.OPENAI_API_KEY = "sk-local-secret";
    process.env.DIJIE_SECRET = "raw-dijie-secret";
    try {
      const outputRoot = mkdtempSync(path.join(os.tmpdir(), "dijie-role-output-"));
      const roleBuilderTool = registerRoleBuilder({
        rolePackageOutputRoot: outputRoot,
      });

      const result = await roleBuilderTool.execute("call-1", toolParams());

      expect(result.details).toMatchObject({
        ok: true,
        status: "completed",
      });
      expect(existsSync(path.join(outputRoot, "role_package", "secret-leak.txt"))).toBe(false);
    } finally {
      if (previousOpenAiKey === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = previousOpenAiKey;
      }
      if (previousDijieSecret === undefined) {
        delete process.env.DIJIE_SECRET;
      } else {
        process.env.DIJIE_SECRET = previousDijieSecret;
      }
    }
  });

  it("uploads RoleResult and AuditSummary to cloud audit when configured", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ ok: true, auditRecordId: "audit_123" }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    const outputRoot = mkdtempSync(path.join(os.tmpdir(), "dijie-role-output-"));
    const roleBuilderTool = registerRoleBuilder({
      rolePackageOutputRoot: outputRoot,
      cloudAuditUrl: "https://mercur.test/dijie/audit",
      cloudAuditUploadRequired: true,
    });

    const result = await roleBuilderTool.execute("call-1", toolParams());

    expect(result.details).toMatchObject({
      ok: true,
      status: "completed",
      auditUpload: {
        ok: true,
        skipped: false,
        required: true,
        statusCode: 200,
        response: { ok: true, auditRecordId: "audit_123" },
      },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://mercur.test/dijie/audit",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          authorization: `Bearer ${toolParams().execution_token}`,
          "content-type": "application/json",
        }),
      }),
    );
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.auditSummary).toMatchObject({
      executionId: "exec_123",
      roleListingId: "prod_role_developer_agent",
      entitlementId: "ordgrp_123",
      deviceId: "device_123",
      workspaceRef: "workspace_123",
      localGatewayId: "gateway_123",
      status: "completed",
      roleTokenPricing: {
        inputTokenCentsPerMillion: 120,
        outputTokenCentsPerMillion: 480,
        developerReceivableBps: 10000,
        platformFeeBps: 0,
      },
      modelProxyUsage: { requestCount: 0, inputTokens: 0, outputTokens: 0 },
      toolUsage: { shellCommands: 1, testsRun: 1, filesRead: 0, filesChanged: 5 },
      result: {
        executionId: "exec_123",
        roleListingId: "prod_role_developer_agent",
        packageId: "pkg_developer_agent",
        packageVersion: "1.0.0",
        developerRef: "dev_001",
        listingOwnerRef: "seller_001",
        billingBeneficiaryRef: "dev_001",
        status: "completed",
        roleTokenPricing: {
          inputTokenCentsPerMillion: 120,
          outputTokenCentsPerMillion: 480,
          developerReceivableBps: 10000,
          platformFeeBps: 0,
        },
        modelProxyUsage: { requestCount: 0, inputTokens: 0, outputTokens: 0 },
      },
    });
  });

  it("fails clearly when required cloud audit upload fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 503,
        text: async () => "Dijie audit sink is not configured.",
      })),
    );
    const roleBuilderTool = registerRoleBuilder({
      cloudAuditUrl: "https://mercur.test/dijie/audit",
      cloudAuditUploadRequired: true,
    });

    const result = await roleBuilderTool.execute("call-1", toolParams());

    expect(result.details).toMatchObject({
      ok: false,
      status: "completed",
      summary: "迭界AI role-builder audit upload failed",
      auditUpload: {
        ok: false,
        skipped: false,
        required: true,
        statusCode: 503,
        error: "Dijie audit sink is not configured.",
      },
    });
  });

  it("fails validation when the local executor omits minimum role_package files", async () => {
    const outputRoot = mkdtempSync(path.join(os.tmpdir(), "dijie-role-output-"));
    const roleBuilderTool = registerRoleBuilder({
      rolePackageOutputRoot: outputRoot,
      localExecutorCommand: createFakeLocalExecutorBinary({
        files: {
          "role_package/manifest.json": JSON.stringify({ name: "role-builder" }),
        },
      }),
    });

    const result = await roleBuilderTool.execute("call-1", toolParams());

    expect(result.details).toMatchObject({
      ok: false,
      status: "failed",
      summary: "迭界AI role-builder local executor failed or produced an invalid role_package",
      rolePackageValidation: {
        ok: false,
        errors: [
          "missing role_package/listing.md",
          "missing role_package/README.md",
          "missing role_package wrapper, adapter, or integration example file",
          "missing role_package validation or smoke test material",
        ],
      },
      result: {
        status: "failed",
        error:
          "role_package validation failed: missing role_package/listing.md; missing role_package/README.md; missing role_package wrapper, adapter, or integration example file; missing role_package validation or smoke test material",
      },
    });
  });

  it("fails closed at preflight before the local executor can write a package", async () => {
    const outputRoot = mkdtempSync(path.join(os.tmpdir(), "dijie-role-output-"));
    const roleBuilderTool = registerRoleBuilder({
      rolePackageOutputRoot: outputRoot,
    });

    await expect(
      roleBuilderTool.execute("call-1", toolParams({ device_id: "wrong_device" })),
    ).rejects.toThrow(
      "dijie.execution.preflight failed: context_mismatch: Execution token deviceId does not match local request context.",
    );
    expect(existsSync(path.join(outputRoot, "role_package"))).toBe(false);
  });

  it("rejects confirmed role-builder runs without cloud execution token context", async () => {
    const registerTool = vi.fn();

    plugin.register({
      pluginConfig: {
        allowWrites: true,
        executionTokenPublicKeyPem: publicKeyPem,
        rolePackageOutputRoot: mkdtempSync(path.join(os.tmpdir(), "dijie-role-output-")),
        localExecutorCommand: createFakeLocalExecutorBinary(),
      },
      registerGatewayMethod: vi.fn(),
      registerTool,
    } as never);

    const roleBuilderTool = registerTool.mock.calls
      .map((call) => call[0])
      .find((tool) => tool.name === "dijie_role_builder");

    await expect(
      roleBuilderTool.execute("call-1", toolParams({ execution_token: undefined })),
    ).rejects.toThrow("execution_token is required when confirm_brief=true");
  });

  it("fails closed when no local execution engine is configured", async () => {
    const registerTool = vi.fn();

    plugin.register({
      pluginConfig: {
        allowWrites: true,
        executionTokenPublicKeyPem: publicKeyPem,
        rolePackageOutputRoot: mkdtempSync(path.join(os.tmpdir(), "dijie-role-output-")),
      },
      registerGatewayMethod: vi.fn(),
      registerTool,
    } as never);

    const roleBuilderTool = registerTool.mock.calls
      .map((call) => call[0])
      .find((tool) => tool.name === "dijie_role_builder");

    await expect(roleBuilderTool.execute("call-1", toolParams())).rejects.toThrow(
      "confirm_brief requires OpenClaw-native runEmbeddedAgent or aics.localExecutorCommand",
    );
  });
});
