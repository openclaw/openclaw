import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type RequestListener, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { text as readRequestBody } from "node:stream/consumers";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { listenOnLoopback } from "../../test-support/hanging-loopback-server.js";
import manifest from "../openclaw.plugin.json" with { type: "json" };
import packageJson from "../package.json" with { type: "json" };

const resolverPath = fileURLToPath(new URL("../vault-secret-ref-resolver.js", import.meta.url));
const secretId = "providers/openai/apiKey";
const batchIds = [secretId, "tts/elevenlabs/apiKey"];
const vaultValue = { data: { data: { apiKey: "not-a-real-vault-value" } } };
const resolvedValues = { [secretId]: "not-a-real-vault-value" };
const deniedErrors = ["permission denied", "not-a-real-sensitive-value"];
const emptyVaultEnv = {
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
};

type ResolverOptions = {
  ids?: string[];
  resolverExecutablePath?: string;
  timeoutMs?: number;
};
type ResolverResult = { stdout: string; stderr: string; code: number | null; timedOut: boolean };

async function runResolver(
  env: Record<string, string>,
  options: ResolverOptions = {},
): Promise<ResolverResult> {
  const child = spawn(process.execPath, [options.resolverExecutablePath ?? resolverPath], {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      ...emptyVaultEnv,
      ...env,
    },
  });
  let timedOut = false;
  const timeout =
    options.timeoutMs === undefined
      ? undefined
      : setTimeout(() => {
          timedOut = true;
          child.kill();
        }, options.timeoutMs);
  const clearWatchdog = () => clearTimeout(timeout);
  child.once("error", clearWatchdog);
  child.once("exit", clearWatchdog);
  // Process exit ends the watchdog; pipe closure owns the complete JSON response.
  const closed = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  child.stdin.end(
    `${JSON.stringify({ protocolVersion: 1, provider: "vault", ids: options.ids ?? [secretId] })}\n`,
  );
  const [code, stdout, stderr] = await Promise.all([
    closed,
    readRequestBody(child.stdout),
    readRequestBody(child.stderr),
  ]);
  return { code, stdout, stderr, timedOut };
}

function expectResponse(
  result: Awaited<ReturnType<typeof runResolver>>,
  errors: Record<string, unknown> = {},
  code = 0,
  values: Record<string, string> = {},
) {
  expect(result).toMatchObject({ code, stderr: "", timedOut: false });
  expect(JSON.parse(result.stdout)).toEqual({
    protocolVersion: 1,
    values,
    errors: Object.fromEntries(Object.entries(errors).map(([id, message]) => [id, { message }])),
  });
}

function idErrors(message: (id: string) => string) {
  return Object.fromEntries(batchIds.map((id) => [id, message(id)]));
}

function runTokenResolver(vaultAddr: string, options: ResolverOptions = {}) {
  return runResolver({ VAULT_ADDR: vaultAddr, VAULT_TOKEN: "not-a-real-auth-header" }, options);
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

async function writeTempFile(value: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "openclaw-vault-test-"));
  tempDirs.push(dir);
  const filePath = path.join(dir, "credential");
  await writeFile(filePath, value, "utf8");
  return filePath;
}

async function authEnv(method: string, value: string): Promise<Record<string, string>> {
  const key =
    method === "token"
      ? "VAULT_TOKEN"
      : method === "token_file"
        ? "VAULT_TOKEN_FILE"
        : "OPENCLAW_VAULT_JWT_FILE";
  return {
    OPENCLAW_VAULT_AUTH_METHOD: method === "token" ? "" : method,
    OPENCLAW_VAULT_AUTH_ROLE: "openclaw",
    [key]: method === "token" ? value : await writeTempFile(value),
  };
}

async function startVaultServer(handler: RequestListener): Promise<string> {
  const server = createServer(handler);
  const port = await listenOnLoopback(server);
  servers.push({
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        // A failed assertion must also release stalled response sockets.
        server.closeAllConnections();
      }),
  });
  return `http://127.0.0.1:${port}`;
}

type VaultReply = { payload: unknown; status?: number };
type VaultRequest = [
  url: string | undefined,
  method: string | undefined,
  token: string | undefined,
  namespace: string | undefined,
  body: unknown,
];

async function startVaultFixture(replies: Record<string, VaultReply> = {}) {
  const requests: VaultRequest[] = [];
  const vaultAddr = await startVaultServer((request, response) => {
    void readRequestBody(request)
      .then((body) => {
        requests.push([
          request.url,
          request.method,
          request.headers["x-vault-token"]?.toString(),
          request.headers["x-vault-namespace"]?.toString(),
          body ? JSON.parse(body) : undefined,
        ]);
        const login = [
          "/v1/auth/keycloak/login",
          "/v1/auth/kubernetes/login",
          "/v1/auth/jwt/login",
        ].includes(request.url ?? "");
        const reply: VaultReply = replies[request.url ?? ""] ??
          replies["*"] ?? {
            payload: login
              ? { auth: { client_token: "not-a-real-vault-client-token" } }
              : vaultValue,
          };
        replyJson(response, reply.payload, reply.status);
      })
      .catch((error: unknown) => {
        response.statusCode = 500;
        response.end(error instanceof Error ? error.message : String(error));
      });
  });
  return { requests, vaultAddr };
}

function replyJson(response: ServerResponse, payload: unknown, statusCode = 200) {
  response.statusCode = statusCode;
  response.end(JSON.stringify(payload));
}

it("declares the Vault resolver as a managed Node SecretRef preset", () => {
  const resolverSource = readFileSync(resolverPath, "utf8");
  const childTimeoutMatch = /const VAULT_FETCH_TIMEOUT_MS = (\d+);/u.exec(resolverSource);
  const childTimeoutMs = Number(childTimeoutMatch?.[1]);
  const preset: Record<string, unknown> = manifest.secretProviderIntegrations.vault;

  expect(preset).toMatchObject({
    providerAlias: "vault",
    source: "exec",
    command: "${node}",
    args: ["./vault-secret-ref-resolver.js"],
    passEnv: expect.arrayContaining([
      ...Object.keys(emptyVaultEnv),
      "NODE_EXTRA_CA_CERTS",
      "NODE_USE_SYSTEM_CA",
    ]),
  });
  expect(childTimeoutMs).toBeGreaterThan(0);
  expect(preset?.timeoutMs).toBeGreaterThan(childTimeoutMs * 2);
  expect(preset?.noOutputTimeoutMs).toBeGreaterThan(childTimeoutMs * 2);
  expect(preset?.passEnv).not.toContain("OPENCLAW_VAULT_VALUES_JSON");
  expect(preset?.allowInsecurePath).toBeUndefined();
  for (const output of ["vault-secret-ref-resolver.js", "vault-secret-id.js"]) {
    expect(packageJson.openclaw.build.staticAssets).toContainEqual({
      source: `./${output}`,
      output,
    });
  }
});
it("keeps malformed successful Vault responses scoped per id", async () => {
  const vaultAddr = await startVaultServer((_request, response) => {
    response.end("not-json");
  });
  const result = await runTokenResolver(vaultAddr, { ids: batchIds });

  expectResponse(
    result,
    idErrors((id) => `Vault read response for "${id}" was not valid JSON.`),
  );
});

it("requires Vault auth instead of accepting plaintext inline values", async () => {
  const result = await runResolver(
    {
      VAULT_ADDR: "https://vault.example.test",
      OPENCLAW_VAULT_VALUES_JSON: JSON.stringify(
        Object.fromEntries(batchIds.map((id) => [id, "not-a-real-value"])),
      ),
    },
    { ids: batchIds },
  );

  expectResponse(result, { request: "VAULT_TOKEN is required." }, 1);
});

it.each([
  ["token", "team-a", "", ""],
  ["token_file", "", "", ""],
  ["jwt", "team-a", "keycloak", "/v1/auth/keycloak/login"],
  ["kubernetes", "", "", "/v1/auth/kubernetes/login"],
])("reads KV v2 secrets using %s credentials", async (method, namespace, mount, loginPath) => {
  const fixture = await startVaultFixture();
  const jwt = "not-a-real-workload-jwt";
  const token = loginPath ? "not-a-real-vault-client-token" : "not-a-real-token";
  const result = await runResolver({
    VAULT_ADDR: fixture.vaultAddr,
    ...(await authEnv(method, `${loginPath ? jwt : token}\n`)),
    OPENCLAW_VAULT_AUTH_MOUNT: mount,
    VAULT_NAMESPACE: namespace,
  });

  expectResponse(result, {}, 0, resolvedValues);
  const ns = namespace || undefined;
  const read: VaultRequest = ["/v1/secret/data/providers/openai", "GET", token, ns, undefined];
  const login: VaultRequest = [loginPath, "POST", undefined, ns, { role: "openclaw", jwt }];
  expect(fixture.requests).toEqual(loginPath ? [login, read] : [read]);
});

it.each([
  ["providers/../../../sys/mounts/apiKey", "dot"],
  ["providers//openai/apiKey", "empty"],
])("rejects invalid path segments in %s before sending a Vault request", async (id, kind) => {
  const fixture = await startVaultFixture();
  const result = await runTokenResolver(fixture.vaultAddr, { ids: [id] });

  expectResponse(result, {
    [id]: `Vault SecretRef id "${id}" must not contain ${kind} path segments.`,
  });
  expect(fixture.requests).toEqual([]);
});

it.each(["token_file", "jwt"])(
  "rejects oversized %s credentials before sending a request",
  async (method) => {
    const fixture = await startVaultFixture();
    const result = await runResolver({
      VAULT_ADDR: fixture.vaultAddr,
      ...(await authEnv(method, "x".repeat(16 * 1024 + 1))),
    });

    expectResponse(result, { request: expect.stringContaining("exceeds 16384 bytes") }, 1);
    expect(fixture.requests).toEqual([]);
  },
);

it.each([
  [403, 200, "none", ""],
  [403, 403, "none", ""],
  [403, 503, "none", ""],
  [403, 403, "lookup", "Vault token is invalid."],
  [403, 200, "read", "Vault read failed (403)."],
  [412, 200, "none", "Vault read failed (412)."],
  [472, 200, "none", "Vault read failed (472)."],
  [473, 200, "none", "Vault read failed (473)."],
  [503, 200, "none", "Vault read failed (503)."],
] as const)(
  "scopes read %s / lookup %s failures with invalid token at %s",
  async (readStatus, lookupStatus, invalidAt, providerError) => {
    const errors = (stage: string) => ({
      errors: [...deniedErrors, ...(invalidAt === stage ? ["invalid token"] : [])],
    });
    const fixture = await startVaultFixture({
      "*": { status: readStatus, payload: errors("read") },
      "/v1/auth/token/lookup-self": {
        status: lookupStatus,
        payload:
          lookupStatus === 200 ? { data: { id: "redacted-fixture-token" } } : errors("lookup"),
      },
    });
    const result = await runTokenResolver(fixture.vaultAddr, { ids: batchIds });
    expectResponse(
      result,
      providerError
        ? { request: providerError }
        : idErrors((id) => `Vault read failed for "${id}" (403).`),
      providerError ? 1 : 0,
    );
  },
);

it("preserves per-id failures when a sibling Vault read has a provider outage", async () => {
  const vaultAddr = await startVaultServer((request, response) => {
    replyJson(
      response,
      { errors: ["not-a-real-sensitive-value"] },
      request.url?.includes("/providers/openai") ? 403 : 503,
    );
  });
  const result = await runTokenResolver(vaultAddr, { ids: batchIds });

  expectResponse(result, {
    [secretId]: `Vault read failed for "${secretId}" (403).`,
    "tts/elevenlabs/apiKey": "Vault read failed (503).",
  });
});

it("does not echo Vault jwt login response bodies in resolver errors", async () => {
  const { vaultAddr } = await startVaultFixture({
    "/v1/auth/jwt/login": {
      status: 403,
      payload: { errors: ["jwt not-a-real-sensitive-jwt denied"] },
    },
  });
  const result = await runResolver({
    VAULT_ADDR: vaultAddr,
    ...(await authEnv("jwt", "not-a-real-sensitive-jwt\n")),
  });

  expectResponse(result, { request: "Vault jwt login failed (403)." }, 1);
});

it("times out while reading a stalled Vault JSON response body", async () => {
  const vaultAddr = await startVaultServer((_request, response) => {
    response.write('{"data":{"data":{"value":"partial');
  });
  const result = await runTokenResolver(vaultAddr, {
    resolverExecutablePath: await writeTimeoutResolver(),
    timeoutMs: 2_500,
  });

  expectResponse(result, { request: "Vault request failed." }, 1);
});

it("cancels oversized Vault error bodies before clearing the fetch timeout", async () => {
  const vaultAddr = await startVaultServer((request, response) => {
    if (request.url === "/v1/auth/token/lookup-self") {
      replyJson(response, { data: { id: "redacted-fixture-token" } });
      return;
    }
    response.statusCode = 403;
    response.setHeader("content-length", String(64 * 1024 + 1));
    response.write('{"errors":["partial');
  });
  const result = await runTokenResolver(vaultAddr, { timeoutMs: 6_500 });

  expectResponse(result, { [secretId]: `Vault read failed for "${secretId}" (403).` });
});
