import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type RequestListener } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const resolverPath = fileURLToPath(new URL("../vault-secret-ref-resolver.js", import.meta.url));
const secretIdHelperPath = fileURLToPath(new URL("../vault-secret-id.js", import.meta.url));
const manifestPath = fileURLToPath(new URL("../openclaw.plugin.json", import.meta.url));
const packagePath = fileURLToPath(new URL("../package.json", import.meta.url));

function runResolver(params: {
  ids?: string[];
  env?: Record<string, string>;
  resolverExecutablePath?: string;
  timeoutMs?: number;
}): Promise<{ stdout: string; stderr: string; code: number | null; timedOut: boolean }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [params.resolverExecutablePath ?? resolverPath], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        VAULT_ADDR: "",
        VAULT_TOKEN: "",
        VAULT_TOKEN_FILE: "",
        VAULT_NAMESPACE: "",
        OPENCLAW_VAULT_AUTH_METHOD: "",
        OPENCLAW_VAULT_AUTH_MOUNT: "",
        OPENCLAW_VAULT_AUTH_ROLE: "",
        OPENCLAW_VAULT_JWT_FILE: "",
        OPENCLAW_VAULT_KV_MOUNT: "",
        OPENCLAW_VAULT_KV_VERSION: "",
        ...params.env,
      },
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timeout =
      params.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            child.kill();
          }, params.timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.once("error", (error) => {
      if (timeout) {
        clearTimeout(timeout);
      }
      reject(error);
    });
    child.once("exit", () => {
      if (timeout) {
        clearTimeout(timeout);
      }
    });
    // Process exit ends the watchdog; pipe closure owns the complete JSON response.
    child.once("close", (code) => resolve({ stdout, stderr, code, timedOut }));
    child.stdin.end(
      `${JSON.stringify({
        protocolVersion: 1,
        provider: "vault",
        ids: params.ids ?? ["providers/openai/apiKey"],
      })}\n`,
    );
  });
}

function expectResponse(
  result: Awaited<ReturnType<typeof runResolver>>,
  expected: {
    code?: number;
    values?: Record<string, string>;
    errors?: Record<string, unknown>;
  },
) {
  expect(result).toMatchObject({ code: expected.code ?? 0, stderr: "", timedOut: false });
  expect(JSON.parse(result.stdout)).toEqual({
    protocolVersion: 1,
    values: expected.values ?? {},
    errors: Object.fromEntries(
      Object.entries(expected.errors ?? {}).map(([id, message]) => [id, { message }]),
    ),
  });
}

const servers: Array<{ close: () => Promise<void> }> = [];
const tempDirs: string[] = [];

async function writeTimeoutResolver(): Promise<string> {
  const staged = path.join(path.dirname(resolverPath), `.vault-timeout-${process.pid}.js`);
  tempDirs.push(staged);
  const source = readFileSync(resolverPath, "utf8");
  const stagedSource = source.replace(
    "const VAULT_FETCH_TIMEOUT_MS = 5000;",
    "const VAULT_FETCH_TIMEOUT_MS = 500;",
  );
  expect(stagedSource).not.toBe(source);
  await writeFile(staged, stagedSource, "utf8");
  return staged;
}

afterEach(async () => {
  try {
    await Promise.all(servers.splice(0).map((server) => server.close()));
  } finally {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
  }
});

async function writeTempFile(name: string, value: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "openclaw-vault-test-"));
  tempDirs.push(dir);
  const filePath = path.join(dir, name);
  await writeFile(filePath, value, "utf8");
  return filePath;
}

async function startVaultServer(handler: RequestListener): Promise<string> {
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  servers.push({
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        // A failed assertion must also release stalled response sockets.
        server.closeAllConnections();
      }),
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("fixture server did not bind to a TCP port");
  }
  return `http://127.0.0.1:${address.port}`;
}

async function startVaultFixture() {
  const requests: Array<{ url?: string; token?: string; namespace?: string }> = [];
  const vaultAddr = await startVaultServer((request, response) => {
    requests.push({
      url: request.url,
      token: request.headers["x-vault-token"]?.toString(),
      namespace: request.headers["x-vault-namespace"]?.toString(),
    });
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({
        data: {
          data: {
            apiKey: "not-a-real-vault-value",
          },
        },
      }),
    );
  });
  return {
    requests,
    vaultAddr,
  };
}

async function startVaultErrorFixture(
  statusCode = 403,
  errors = ["token not-a-real-sensitive-value denied"],
  lookupSucceeds = true,
  lookupErrors = errors,
  lookupStatusCode = statusCode,
) {
  const requests: string[] = [];
  const vaultAddr = await startVaultServer((request, response) => {
    requests.push(request.url ?? "");
    if (request.url === "/v1/auth/token/lookup-self" && lookupSucceeds) {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ data: { id: "redacted-fixture-token" } }));
      return;
    }
    response.statusCode =
      request.url === "/v1/auth/token/lookup-self" ? lookupStatusCode : statusCode;
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({
        errors: request.url === "/v1/auth/token/lookup-self" ? lookupErrors : errors,
      }),
    );
  });
  return {
    requests,
    vaultAddr,
  };
}

async function readRequestBody(request: import("node:http").IncomingMessage): Promise<string> {
  return await new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += String(chunk);
    });
    request.on("error", reject);
    request.on("end", () => resolve(body));
  });
}

async function startVaultJwtFixture() {
  const requests: Array<{
    url?: string;
    method?: string;
    token?: string;
    namespace?: string;
    body?: unknown;
  }> = [];
  const vaultAddr = await startVaultServer((request, response) => {
    void (async () => {
      const body = await readRequestBody(request);
      requests.push({
        url: request.url,
        method: request.method,
        token: request.headers["x-vault-token"]?.toString(),
        namespace: request.headers["x-vault-namespace"]?.toString(),
        body: body ? JSON.parse(body) : undefined,
      });
      response.setHeader("content-type", "application/json");
      if (
        request.url === "/v1/auth/keycloak/login" ||
        request.url === "/v1/auth/kubernetes/login"
      ) {
        response.end(
          JSON.stringify({
            auth: {
              client_token: "not-a-real-vault-client-token",
            },
          }),
        );
        return;
      }
      response.end(
        JSON.stringify({
          data: {
            data: {
              apiKey: "not-a-real-vault-value",
            },
          },
        }),
      );
    })().catch((error: unknown) => {
      response.statusCode = 500;
      response.end(error instanceof Error ? error.message : String(error));
    });
  });
  return {
    requests,
    vaultAddr,
  };
}

describe("plugin manifest", () => {
  it("declares the Vault resolver as a managed Node SecretRef preset", () => {
    const resolverSource = readFileSync(resolverPath, "utf8");
    const childTimeoutMatch = /const VAULT_FETCH_TIMEOUT_MS = (\d+);/u.exec(resolverSource);
    const childTimeoutMs = Number(childTimeoutMatch?.[1]);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      secretProviderIntegrations?: Record<string, Record<string, unknown>>;
    };
    const packageJson = JSON.parse(readFileSync(packagePath, "utf8")) as {
      openclaw?: {
        build?: {
          staticAssets?: Array<{ source?: string; output?: string }>;
        };
      };
    };

    expect(manifest.secretProviderIntegrations?.vault).toMatchObject({
      providerAlias: "vault",
      source: "exec",
      command: "${node}",
      args: ["./vault-secret-ref-resolver.js"],
      passEnv: expect.arrayContaining([
        "VAULT_ADDR",
        "VAULT_TOKEN",
        "VAULT_TOKEN_FILE",
        "OPENCLAW_VAULT_AUTH_METHOD",
        "OPENCLAW_VAULT_AUTH_MOUNT",
        "OPENCLAW_VAULT_AUTH_ROLE",
        "OPENCLAW_VAULT_JWT_FILE",
        "NODE_EXTRA_CA_CERTS",
        "NODE_USE_SYSTEM_CA",
      ]),
    });
    expect(childTimeoutMs).toBeGreaterThan(0);
    expect(manifest.secretProviderIntegrations?.vault?.timeoutMs).toBeGreaterThan(
      childTimeoutMs * 2,
    );
    expect(manifest.secretProviderIntegrations?.vault?.noOutputTimeoutMs).toBeGreaterThan(
      childTimeoutMs * 2,
    );
    expect(manifest.secretProviderIntegrations?.vault?.passEnv).not.toContain(
      "OPENCLAW_VAULT_VALUES_JSON",
    );
    expect(manifest.secretProviderIntegrations?.vault?.allowInsecurePath).toBeUndefined();
    expect(resolverSource).toContain("#!/usr/bin/env node");
    const pluginSdkRootImport = ["openclaw", "plugin-sdk"].join("/");
    expect(resolverSource).not.toContain(pluginSdkRootImport);
    expect(resolverSource).toContain("@openclaw/fs-safe/secret");
    expect(packageJson.openclaw?.build?.staticAssets).toContainEqual({
      source: "./vault-secret-ref-resolver.js",
      output: "vault-secret-ref-resolver.js",
    });
    expect(packageJson.openclaw?.build?.staticAssets).toContainEqual({
      source: "./vault-secret-id.js",
      output: "vault-secret-id.js",
    });
    expect(readFileSync(secretIdHelperPath, "utf8")).toContain("parseVaultSecretId");
  });
});

describe("vault SecretRef resolver", () => {
  it("keeps malformed successful Vault responses scoped per id", async () => {
    const vaultAddr = await startVaultServer((_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end("not-json");
    });
    const result = await runResolver({
      ids: ["providers/openai/apiKey", "tts/elevenlabs/apiKey"],
      env: {
        VAULT_ADDR: vaultAddr,
        VAULT_TOKEN: "not-a-real-auth-header",
      },
    });

    expectResponse(result, {
      errors: {
        "providers/openai/apiKey":
          'Vault read response for "providers/openai/apiKey" was not valid JSON.',
        "tts/elevenlabs/apiKey":
          'Vault read response for "tts/elevenlabs/apiKey" was not valid JSON.',
      },
    });
  });

  it("requires Vault auth instead of accepting plaintext inline values", async () => {
    const result = await runResolver({
      ids: ["providers/openai/apiKey", "tts/elevenlabs/apiKey"],
      env: {
        VAULT_ADDR: "https://vault.example.test",
        OPENCLAW_VAULT_VALUES_JSON: JSON.stringify({
          "providers/openai/apiKey": "not-a-real-value",
          "tts/elevenlabs/apiKey": "not-a-real-value",
        }),
      },
    });

    expectResponse(result, {
      code: 1,
      errors: {
        request: "VAULT_TOKEN is required.",
      },
    });
  });

  it.each([
    { method: "token", namespace: "team-a" },
    { method: "token_file", namespace: "" },
  ])("reads KV v2 secrets using $method credentials", async ({ method, namespace }) => {
    const fixture = await startVaultFixture();
    const token = "not-a-real-token";
    const credentials: Record<string, string> =
      method === "token_file"
        ? { VAULT_TOKEN_FILE: await writeTempFile("vault-token", `${token}\n`) }
        : { VAULT_TOKEN: token };
    const result = await runResolver({
      env: {
        VAULT_ADDR: fixture.vaultAddr,
        ...credentials,
        OPENCLAW_VAULT_AUTH_METHOD: method === "token" ? "" : method,
        VAULT_NAMESPACE: namespace,
      },
    });

    expectResponse(result, {
      values: { "providers/openai/apiKey": "not-a-real-vault-value" },
    });
    expect(fixture.requests).toEqual([
      { url: "/v1/secret/data/providers/openai", token, namespace: namespace || undefined },
    ]);
  });

  it.each([
    ["providers/../../../sys/mounts/apiKey", "dot"],
    ["providers//openai/apiKey", "empty"],
  ])("rejects invalid path segments in %s before sending a Vault request", async (id, kind) => {
    const fixture = await startVaultFixture();
    const result = await runResolver({
      ids: [id],
      env: {
        VAULT_ADDR: fixture.vaultAddr,
        VAULT_TOKEN: "not-a-real-auth-header",
      },
    });

    expectResponse(result, {
      errors: { [id]: `Vault SecretRef id "${id}" must not contain ${kind} path segments.` },
    });
    expect(fixture.requests).toEqual([]);
  });

  it.each([
    ["token_file", "VAULT_TOKEN_FILE"],
    ["jwt", "OPENCLAW_VAULT_JWT_FILE"],
  ])("rejects oversized %s credentials before sending a request", async (method, fileEnv) => {
    const fixture = await startVaultFixture();
    const credentialFile = await writeTempFile("vault-credential", "x".repeat(16 * 1024 + 1));
    const result = await runResolver({
      env: {
        VAULT_ADDR: fixture.vaultAddr,
        [fileEnv]: credentialFile,
        OPENCLAW_VAULT_AUTH_METHOD: method,
        OPENCLAW_VAULT_AUTH_ROLE: "openclaw",
      },
    });

    expectResponse(result, {
      code: 1,
      errors: { request: expect.stringContaining("exceeds 16384 bytes") },
    });
    expect(fixture.requests).toEqual([]);
  });

  it.each([
    { method: "jwt", mount: "keycloak", namespace: "team-a", loginPath: "/v1/auth/keycloak/login" },
    { method: "kubernetes", mount: "", namespace: "", loginPath: "/v1/auth/kubernetes/login" },
  ])("exchanges $method JWTs using the configured or default mount", async (auth) => {
    const fixture = await startVaultJwtFixture();
    const jwtFile = await writeTempFile("vault-jwt", "not-a-real-workload-jwt\n");
    const result = await runResolver({
      env: {
        VAULT_ADDR: fixture.vaultAddr,
        VAULT_NAMESPACE: auth.namespace,
        OPENCLAW_VAULT_AUTH_METHOD: auth.method,
        OPENCLAW_VAULT_AUTH_MOUNT: auth.mount,
        OPENCLAW_VAULT_AUTH_ROLE: "openclaw",
        OPENCLAW_VAULT_JWT_FILE: jwtFile,
      },
    });

    expectResponse(result, {
      values: { "providers/openai/apiKey": "not-a-real-vault-value" },
    });
    expect(fixture.requests).toEqual([
      {
        url: auth.loginPath,
        method: "POST",
        token: undefined,
        namespace: auth.namespace || undefined,
        body: { role: "openclaw", jwt: "not-a-real-workload-jwt" },
      },
      {
        url: "/v1/secret/data/providers/openai",
        method: "GET",
        token: "not-a-real-vault-client-token",
        namespace: auth.namespace || undefined,
        body: undefined,
      },
    ]);
  });

  it.each([
    { label: "successful", lookupSucceeds: true, lookupStatus: 200, lookupErrors: [] },
    {
      label: "denied",
      lookupSucceeds: false,
      lookupStatus: 403,
      lookupErrors: ["permission denied"],
    },
    {
      label: "unavailable",
      lookupSucceeds: false,
      lookupStatus: 503,
      lookupErrors: ["temporarily unavailable"],
    },
  ])("keeps ACL failures scoped per id when token lookup is $label", async (lookup) => {
    const fixture = await startVaultErrorFixture(
      403,
      ["token not-a-real-sensitive-value denied"],
      lookup.lookupSucceeds,
      lookup.lookupErrors,
      lookup.lookupStatus,
    );
    const result = await runResolver({
      ids: ["providers/openai/apiKey", "tts/elevenlabs/apiKey"],
      env: {
        VAULT_ADDR: fixture.vaultAddr,
        VAULT_TOKEN: "not-a-real-auth-header",
      },
    });

    expectResponse(result, {
      errors: {
        "providers/openai/apiKey": 'Vault read failed for "providers/openai/apiKey" (403).',
        "tts/elevenlabs/apiKey": 'Vault read failed for "tts/elevenlabs/apiKey" (403).',
      },
    });
    expect(result.stdout).not.toContain("not-a-real-sensitive-value");
    expect(fixture.requests.filter((url) => url === "/v1/auth/token/lookup-self")).toHaveLength(1);
  });

  it("reports one provider failure when Vault rejects an invalid token", async () => {
    const fixture = await startVaultErrorFixture(403, ["permission denied", "invalid token"]);
    const result = await runResolver({
      ids: ["providers/openai/apiKey", "tts/elevenlabs/apiKey"],
      env: {
        VAULT_ADDR: fixture.vaultAddr,
        VAULT_TOKEN: "not-a-real-auth-header",
      },
    });

    expectResponse(result, {
      code: 1,
      errors: {
        request: "Vault read failed (403).",
      },
    });
    expect(result.stdout).not.toContain("permission denied");
    expect(result.stdout).not.toContain("invalid token");
  });

  it("promotes an explicit invalid-token self-lookup response to one provider failure", async () => {
    const fixture = await startVaultErrorFixture(403, ["permission denied"], false, [
      "invalid token",
      "permission denied",
    ]);
    const result = await runResolver({
      ids: ["providers/openai/apiKey", "tts/elevenlabs/apiKey"],
      env: {
        VAULT_ADDR: fixture.vaultAddr,
        VAULT_TOKEN: "not-a-real-auth-header",
      },
    });

    expectResponse(result, {
      code: 1,
      errors: {
        request: "Vault token is invalid.",
      },
    });
    expect(fixture.requests.filter((url) => url === "/v1/auth/token/lookup-self")).toHaveLength(1);
  });

  it.each([412, 472, 473, 503])(
    "reports one provider failure for Vault availability status %s",
    async (statusCode) => {
      const fixture = await startVaultErrorFixture(statusCode);
      const result = await runResolver({
        ids: ["providers/openai/apiKey", "tts/elevenlabs/apiKey"],
        env: {
          VAULT_ADDR: fixture.vaultAddr,
          VAULT_TOKEN: "not-a-real-auth-header",
        },
      });

      expectResponse(result, {
        code: 1,
        errors: {
          request: `Vault read failed (${statusCode}).`,
        },
      });
      expect(result.stdout).not.toContain("not-a-real-sensitive-value");
    },
  );

  it("preserves per-id failures when a sibling Vault read has a provider outage", async () => {
    const vaultAddr = await startVaultServer((request, response) => {
      response.statusCode = request.url?.includes("/providers/openai") ? 403 : 503;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ errors: ["not-a-real-sensitive-value"] }));
    });
    const result = await runResolver({
      ids: ["providers/openai/apiKey", "tts/elevenlabs/apiKey"],
      env: {
        VAULT_ADDR: vaultAddr,
        VAULT_TOKEN: "not-a-real-auth-header",
      },
    });

    expectResponse(result, {
      errors: {
        "providers/openai/apiKey": 'Vault read failed for "providers/openai/apiKey" (403).',
        "tts/elevenlabs/apiKey": "Vault read failed (503).",
      },
    });
    expect(result.stdout).not.toContain("not-a-real-sensitive-value");
  });

  it("does not echo Vault jwt login response bodies in resolver errors", async () => {
    const vaultAddr = await startVaultServer((request, response) => {
      void readRequestBody(request)
        .then(() => {
          response.statusCode = 403;
          response.setHeader("content-type", "application/json");
          response.end(JSON.stringify({ errors: ["jwt not-a-real-sensitive-jwt denied"] }));
        })
        .catch((error: unknown) => {
          response.statusCode = 500;
          response.end(error instanceof Error ? error.message : String(error));
        });
    });
    const jwtFile = await writeTempFile("vault-jwt", "not-a-real-sensitive-jwt\n");
    const result = await runResolver({
      env: {
        VAULT_ADDR: vaultAddr,
        OPENCLAW_VAULT_AUTH_METHOD: "jwt",
        OPENCLAW_VAULT_AUTH_ROLE: "openclaw",
        OPENCLAW_VAULT_JWT_FILE: jwtFile,
      },
    });

    expectResponse(result, {
      code: 1,
      errors: {
        request: "Vault jwt login failed (403).",
      },
    });
    expect(result.stdout).not.toContain("not-a-real-sensitive-jwt");
  });

  it("times out while reading a stalled Vault JSON response body", async () => {
    const vaultAddr = await startVaultServer((_request, response) => {
      response.setHeader("content-type", "application/json");
      response.write('{"data":{"data":{"value":"partial');
    });
    const result = await runResolver({
      env: {
        VAULT_ADDR: vaultAddr,
        VAULT_TOKEN: "not-a-real-auth-header",
      },
      resolverExecutablePath: await writeTimeoutResolver(),
      timeoutMs: 2_500,
    });

    expectResponse(result, {
      code: 1,
      errors: {
        request: "Vault request failed.",
      },
    });
  });

  it("cancels oversized Vault error bodies before clearing the fetch timeout", async () => {
    const vaultAddr = await startVaultServer((request, response) => {
      if (request.url === "/v1/auth/token/lookup-self") {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ data: { id: "redacted-fixture-token" } }));
        return;
      }
      response.statusCode = 403;
      response.setHeader("content-type", "application/json");
      response.setHeader("content-length", String(64 * 1024 + 1));
      response.write('{"errors":["partial');
    });
    const result = await runResolver({
      env: {
        VAULT_ADDR: vaultAddr,
        VAULT_TOKEN: "not-a-real-auth-header",
      },
      timeoutMs: 6_500,
    });

    expectResponse(result, {
      errors: {
        "providers/openai/apiKey": 'Vault read failed for "providers/openai/apiKey" (403).',
      },
    });
  });
});
