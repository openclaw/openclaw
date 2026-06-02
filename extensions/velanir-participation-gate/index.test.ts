import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { importJWK, jwtVerify } from "jose";
import { describe, expect, it } from "vitest";
import participationGatePlugin, {
  messageClearlyAddressesIdentity,
  normalizeConfig,
  parseClassifierShouldRespond,
  parseParticipationContext,
  PLUGIN_ID,
  PARTICIPATION_CONTEXT_SCOPE,
  runEmbeddedClassifierModel,
  RuntimeParticipationContextAuthClient,
} from "./index.js";

function decodeJwtSegment(segment: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(segment, "base64url").toString("utf8")) as Record<string, unknown>;
}

function decodeJwt(token: string): {
  header: Record<string, unknown>;
  payload: Record<string, unknown>;
} {
  const [header, payload] = token.split(".");
  if (!header || !payload) {
    throw new Error("invalid test jwt");
  }
  return {
    header: decodeJwtSegment(header),
    payload: decodeJwtSegment(payload),
  };
}

function requestInputUrl(input: string | URL | Request): string {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.href;
  }
  return input.url;
}

describe("velanir participation gate", () => {
  it("defaults to runtime platform auth and shadow mode", () => {
    const config = normalizeConfig(
      {},
      {
        OCT8_API_URL: "https://api.oct8.io",
        OCT8_COWORKER_ID: "coworker-1",
      },
    );

    expect(config.mode).toBe("shadow");
    expect(config.platform.authMode).toBe("runtime");
    expect(config.platform.token).toBeUndefined();
    expect(config.platform.baseUrl).toBe("https://api.oct8.io");
    expect(config.platform.coworkerId).toBe("coworker-1");
  });

  it("uses static token only when explicitly configured", () => {
    const config = normalizeConfig(
      { platform: { authMode: "static-token" } },
      {
        OCT8_API_URL: "https://api.oct8.io",
        OCT8_COWORKER_ID: "coworker-1",
        OCT8_PARTICIPATION_CONTEXT_TOKEN: "local-token",
      },
    );

    expect(config.platform.authMode).toBe("static-token");
    expect(config.platform.token).toBe("local-token");
  });

  it("parses platform participation context without keeping self in coworkers", () => {
    expect(
      parseParticipationContext({
        data: {
          self: { id: "self", names: ["Tanya"] },
          coworkers: [
            { id: "self", names: ["Tanya"] },
            { id: "other", names: ["Cedric"], roleSummary: "Operations" },
          ],
        },
      }),
    ).toEqual({
      self: { id: "self", names: ["Tanya"] },
      coworkers: [{ id: "other", names: ["Cedric"], roleSummary: "Operations" }],
    });
  });

  it("recognizes direct address patterns", () => {
    expect(
      messageClearlyAddressesIdentity("Cedric, can you check this?", {
        id: "cedric",
        names: ["Cedric Alvarez", "Cedric"],
      }),
    ).toBe(true);
    expect(
      messageClearlyAddressesIdentity("This is general project chatter.", {
        id: "cedric",
        names: ["Cedric Alvarez"],
      }),
    ).toBe(false);
  });

  it("fails open when classifier output is malformed", () => {
    expect(parseClassifierShouldRespond('{ "shouldRespond": false }')).toBe(false);
    expect(parseClassifierShouldRespond("not json")).toBe(true);
  });

  it("registers before_dispatch", () => {
    const hooks: Array<{ name: string; timeoutMs?: number }> = [];
    participationGatePlugin.register({
      id: PLUGIN_ID,
      name: "Velanir Participation Gate",
      source: "test",
      registrationMode: "runtime",
      config: {},
      pluginConfig: {
        context: { source: "static" },
        staticContext: { self: { id: "self", names: ["Riley"] }, coworkers: [] },
      },
      runtime: {},
      logger: {},
      on(name: string, _handler: unknown, opts?: { timeoutMs?: number }) {
        hooks.push({ name, timeoutMs: opts?.timeoutMs });
      },
    } as never);

    expect(hooks).toEqual([{ name: "before_dispatch", timeoutMs: 7_000 }]);
  });

  it("runs the embedded classifier without model-incompatible temperature params", async () => {
    const calls: Record<string, unknown>[] = [];
    const config = normalizeConfig({
      classifier: {
        provider: "openai",
        model: "gpt-5.4-nano",
        timeoutMs: 1234,
        maxOutputTokens: 12,
      },
    });

    await expect(
      runEmbeddedClassifierModel({
        api: {
          config: { agents: {} },
          runtime: {
            agent: {
              runEmbeddedAgent: async (params: Record<string, unknown>) => {
                calls.push(params);
                return { payloads: [{ text: '{ "shouldRespond": false }' }] };
              },
              resolveAgentWorkspaceDir: () => "/tmp/openclaw-workspace",
            },
          },
        } as never,
        config,
        prompt: "Decide.",
      }),
    ).resolves.toBe('{ "shouldRespond": false }');

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      prompt: "Decide.",
      workspaceDir: "/tmp/openclaw-workspace",
      provider: "openai",
      model: "gpt-5.4-nano",
      timeoutMs: 1234,
      modelRun: true,
      disableTools: true,
      disableMessageTool: true,
      streamParams: {
        maxTokens: 12,
      },
    });
    expect(calls[0]?.streamParams).not.toHaveProperty("temperature");
  });

  it("requests a DPoP token and signs the participation context GET", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "participation-gate-auth-"));
    const runtimeIdentityId = "11111111-1111-4111-8111-111111111111";
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const client = new RuntimeParticipationContextAuthClient({
      env: {
        OCT8_SECRETS_MODE: "runtime",
        OCT8_API_URL: "https://api.oct8.io",
        OCT8_RUNTIME_TOKEN_ISSUER: "https://api.oct8.io",
        OCT8_RUNTIME_IDENTITY_ID: runtimeIdentityId,
        OCT8_RUNTIME_STATE_DIR: stateDir,
      },
      fetchImpl: async (url, init = {}) => {
        requests.push({ url: requestInputUrl(url), init });
        return new Response(
          JSON.stringify({
            access_token: "issued-access-token",
            token_type: "DPoP",
            expires_in: 900,
            scope: PARTICIPATION_CONTEXT_SCOPE,
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      },
      now: () => 1_700_000_000_000,
    });

    try {
      const headers = await client.authorizationHeaders(
        "https://api.oct8.io/v1/runtime/coworkers/22222222-2222-4222-8222-222222222222/participation-context?ignored=true",
      );

      expect(headers.Authorization).toBe("DPoP issued-access-token");
      expect(requests).toHaveLength(1);
      const tokenRequest = requests[0];
      expect(tokenRequest).toBeDefined();
      if (!tokenRequest) {
        throw new Error("missing token request");
      }
      expect(tokenRequest.url).toBe("https://api.oct8.io/v1/runtime/token");
      expect(typeof tokenRequest.init.body).toBe("string");

      const body = new URLSearchParams(tokenRequest.init.body as string);
      expect(body.get("grant_type")).toBe("client_credentials");
      expect(body.get("client_id")).toBe(runtimeIdentityId);
      expect(body.get("scope")).toBe(PARTICIPATION_CONTEXT_SCOPE);

      const assertion = decodeJwt(body.get("client_assertion") ?? "");
      expect(assertion.header).toMatchObject({ alg: "ES256" });
      expect(assertion.payload).toMatchObject({
        iss: runtimeIdentityId,
        sub: runtimeIdentityId,
        aud: "https://api.oct8.io/v1/runtime/token",
      });

      const tokenRequestHeaders = tokenRequest.init.headers as Record<string, string>;
      const tokenProof = decodeJwt(tokenRequestHeaders.DPoP ?? "");
      expect(tokenProof.header).toMatchObject({ typ: "dpop+jwt", alg: "ES256" });
      expect(tokenProof.header.jwk).toMatchObject({
        kty: "EC",
        crv: "P-256",
        alg: "ES256",
        use: "sig",
      });
      expect(tokenProof.header.jwk).not.toHaveProperty("d");
      const publicKey = await importJWK(tokenProof.header.jwk as JsonWebKey, "ES256");
      await expect(
        jwtVerify(body.get("client_assertion") ?? "", publicKey, {
          algorithms: ["ES256"],
          issuer: runtimeIdentityId,
          subject: runtimeIdentityId,
          audience: "https://api.oct8.io/v1/runtime/token",
        }),
      ).resolves.toBeDefined();
      expect(tokenProof.payload).toMatchObject({
        htm: "POST",
        htu: "https://api.oct8.io/v1/runtime/token",
      });

      const getProof = decodeJwt(headers.DPoP);
      expect(getProof.header).toMatchObject({ typ: "dpop+jwt", alg: "ES256" });
      expect(getProof.payload).toMatchObject({
        htm: "GET",
        htu: "https://api.oct8.io/v1/runtime/coworkers/22222222-2222-4222-8222-222222222222/participation-context",
      });
      expect(getProof.payload.ath).toBe(
        createHash("sha256").update("issued-access-token", "ascii").digest("base64url"),
      );
      await expect(
        jwtVerify(headers.DPoP, publicKey, { algorithms: ["ES256"] }),
      ).resolves.toBeDefined();
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });
});
