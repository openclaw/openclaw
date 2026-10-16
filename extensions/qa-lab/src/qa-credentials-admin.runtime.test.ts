// Qa Lab tests cover qa credentials admin plugin behavior.
import http from "node:http";
import type { AddressInfo } from "node:net";
import { MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  addQaCredentialSet,
  diagnoseQaCredentialBroker,
  listQaCredentialSets,
  QaCredentialAdminError,
  removeQaCredentialSet,
} from "./qa-credentials-admin.runtime.js";

const adminOptions = {
  siteUrl: "https://first-schnauzer-821.convex.site",
  env: { OPENCLAW_QA_CONVEX_SECRET_MAINTAINER: "maint-secret" },
};
const payload = { groupId: "-100123", driverToken: "driver", sutToken: "sut" };
const credential = {
  credentialId: "cred-2",
  kind: "telegram",
  status: "active",
  createdAtMs: 100,
  updatedAtMs: 100,
  lastLeasedAtMs: 50,
};
function mockFetch(response: unknown, status = 200) {
  return vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
    jsonResponse(response, status),
  );
}

function jsonResponse(response: unknown, status = 200) {
  return new Response(JSON.stringify(response), {
    status,
    headers: {
      "content-type": "application/json",
    },
  });
}

function requireFirstFetchCall(fetchImpl: ReturnType<typeof mockFetch>) {
  const [call] = fetchImpl.mock.calls;
  if (!call) {
    throw new Error("expected fetch call");
  }
  return call;
}

function requireFirstFetchInit(fetchImpl: ReturnType<typeof mockFetch>): RequestInit {
  const init = requireFirstFetchCall(fetchImpl)[1];
  if (!init) {
    throw new Error("expected fetch init");
  }
  return init;
}

async function expectQaCredentialAdminError(promise: Promise<unknown>, code: string) {
  const error = await promise.then(
    () => undefined,
    (err: unknown) => err,
  );
  expect(error).toBeInstanceOf(QaCredentialAdminError);
  const adminError = error as QaCredentialAdminError;
  expect(adminError.name).toBe("QaCredentialAdminError");
  expect(adminError.code).toBe(code);
}

describe("qa credential admin runtime", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("adds a credential set through the admin endpoint", async () => {
    const fetchImpl = mockFetch({
      status: "ok",
      credential: { ...credential, credentialId: "cred-1", lastLeasedAtMs: 0, note: "qa" },
    });

    const result = await addQaCredentialSet({
      kind: "telegram",
      payload,
      note: "qa",
      actorId: "maintainer-local",
      ...adminOptions,
      fetchImpl,
    });

    expect(result.credential.credentialId).toBe("cred-1");
    expect(result.credential.credentialFingerprint).toMatch(/^sha256:[0-9a-f]{16}$/);
    expect(requireFirstFetchCall(fetchImpl)[0]).toBe(
      "https://first-schnauzer-821.convex.site/qa-credentials/v1/admin/add",
    );
    const init = requireFirstFetchInit(fetchImpl);
    const headers = init?.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer maint-secret");
    const bodyText = init?.body;
    expect(typeof bodyText).toBe("string");
    const body = JSON.parse(bodyText as string) as Record<string, unknown>;
    expect(body).toMatchObject({ kind: "telegram", actorId: "maintainer-local" });
    expect(body.payload).toEqual(payload);
  });

  it("rejects admin commands when maintainer secret is missing", async () => {
    await expectQaCredentialAdminError(
      listQaCredentialSets({
        siteUrl: adminOptions.siteUrl,
        env: {},
        fetchImpl: vi.fn(),
      }),
      "MISSING_MAINTAINER_SECRET",
    );
  });

  it("rejects non-https admin site URLs unless local insecure opt-in is enabled", async () => {
    await expectQaCredentialAdminError(
      listQaCredentialSets({
        ...adminOptions,
        siteUrl: "http://qa-cred.example.convex.site",
        fetchImpl: vi.fn(),
      }),
      "INVALID_SITE_URL",
    );
  });

  it("caps oversized admin HTTP timeouts before creating abort signals", async () => {
    const timeoutController = new AbortController();
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeoutController.signal);
    const fetchImpl = mockFetch({
      status: "ok",
      count: 0,
      credentials: [],
    });

    await listQaCredentialSets({
      siteUrl: adminOptions.siteUrl,
      env: {
        OPENCLAW_QA_CONVEX_SECRET_MAINTAINER: "maint-secret",
        OPENCLAW_QA_CREDENTIAL_HTTP_TIMEOUT_MS: String(Number.MAX_SAFE_INTEGER),
      },
      fetchImpl,
    });

    expect(timeoutSpy).toHaveBeenCalledWith(MAX_TIMER_TIMEOUT_MS);
    expect(requireFirstFetchInit(fetchImpl).signal).toBe(timeoutController.signal);
  });

  it("rejects unsafe endpoint-prefix overrides", async () => {
    await expectQaCredentialAdminError(
      listQaCredentialSets({
        ...adminOptions,
        endpointPrefix: "//evil.example",
        fetchImpl: vi.fn(),
      }),
      "INVALID_ARGUMENT",
    );
  });

  it("surfaces broker error codes for remove", async () => {
    const fetchImpl = mockFetch(
      {
        status: "error",
        code: "LEASE_ACTIVE",
        message: "Credential is currently leased and cannot be disabled.",
      },
      200,
    );

    await expectQaCredentialAdminError(
      removeQaCredentialSet({
        credentialId: "cred-1",
        ...adminOptions,
        fetchImpl,
      }),
      "LEASE_ACTIVE",
    );
  });

  it("lists credentials and forwards includePayload/status filters", async () => {
    const fetchImpl = mockFetch({
      status: "ok",
      count: 1,
      credentials: [{ ...credential, payload }],
    });

    const result = await listQaCredentialSets({
      kind: "telegram",
      status: "active",
      includePayload: true,
      limit: 5,
      ...adminOptions,
      fetchImpl,
    });

    expect(result.credentials).toHaveLength(1);
    expect(result.credentials[0]?.credentialFingerprint).toMatch(/^sha256:[0-9a-f]{16}$/);
    const bodyText = requireFirstFetchInit(fetchImpl).body;
    expect(typeof bodyText).toBe("string");
    const body = JSON.parse(bodyText as string) as Record<string, unknown>;
    expect(body).toEqual({
      kind: "telegram",
      status: "active",
      includePayload: true,
      limit: 5,
    });
  });

  it("rejects and cancels oversized streamed admin responses", async () => {
    const chunk = Buffer.alloc(64 * 1024, "x");
    const totalChunks = 64;
    let chunksSent = 0;
    let responseClosed = false;
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      let nextChunkTimer: ReturnType<typeof setTimeout> | undefined;
      res.once("close", () => {
        responseClosed = true;
        if (nextChunkTimer) {
          clearTimeout(nextChunkTimer);
        }
      });
      const scheduleNext = () => {
        nextChunkTimer = setTimeout(sendNext, 2);
      };
      const sendNext = () => {
        if (res.destroyed || chunksSent >= totalChunks) {
          if (!res.destroyed) {
            res.end();
          }
          return;
        }
        chunksSent += 1;
        if (res.write(chunk)) {
          scheduleNext();
        } else {
          res.once("drain", scheduleNext);
        }
      };
      sendNext();
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const port = (server.address() as AddressInfo).port;

    try {
      const error = await listQaCredentialSets({
        siteUrl: `http://127.0.0.1:${port}`,
        env: {
          OPENCLAW_QA_ALLOW_INSECURE_HTTP: "1",
          OPENCLAW_QA_CONVEX_SECRET_MAINTAINER: "maint-secret",
        },
      }).then(
        () => undefined,
        (err: unknown) => err,
      );

      expect(error).toBeInstanceOf(QaCredentialAdminError);
      const adminError = error as QaCredentialAdminError;
      expect(adminError.code).toBe("BROKER_REQUEST_FAILED");
      expect(adminError.message).toMatch(/Convex credential admin response exceeds/);
      await vi.waitFor(() => expect(responseClosed).toBe(true));
      expect(chunksSent).toBeLessThan(totalChunks);
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  });

  it("doctors credential broker env without exposing secret values", async () => {
    const fetchImpl = mockFetch({
      status: "ok",
      count: 1,
      credentials: [credential],
    });

    const result = await diagnoseQaCredentialBroker({
      siteUrl: adminOptions.siteUrl,
      env: {
        OPENCLAW_QA_CONVEX_SECRET_CI: "ci-secret",
        OPENCLAW_QA_CONVEX_SECRET_MAINTAINER: "maint-secret",
      },
      fetchImpl,
    });

    expect(result.status).toBe("pass");
    expect(JSON.stringify(result)).not.toContain("ci-secret");
    expect(JSON.stringify(result)).not.toContain("maint-secret");
    const brokerCheck = result.checks.find((check) => check.name === "broker admin/list");
    expect(brokerCheck?.status).toBe("pass");
  });
});
