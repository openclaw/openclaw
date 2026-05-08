import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AGENTKIT } from "./agentkit.runtime.js";
import { createAgentkitProtectedResourceChallenge } from "./protected-challenge.js";
import {
  requestAgentkitProtectedResource,
  resolveAgentkitPrivateKeyValue,
} from "./protected-request.js";
import { startAgentkitVerifierServer } from "./verifier-server.js";

const TEST_PRIVATE_KEY =
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f2b2c7e097b123" as const;

const handles: Array<{ close(): Promise<void> }> = [];
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(handles.splice(0).map((handle) => handle.close()));
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("agentkit protected request", () => {
  it("requests a protected resource by negotiating an AgentKit challenge", async () => {
    const handle = await startAgentkitVerifierServer({ port: 0 });
    handles.push(handle);

    const result = await requestAgentkitProtectedResource({
      resourceUrl: handle.info.protectedResourceUrl,
      privateKey: TEST_PRIVATE_KEY,
    });

    expect(result.resourceUrl).toBe(handle.info.protectedResourceUrl);
    expect(result.challengeResourceUrl).toBe(handle.info.protectedResourceUrl);
    expect(result.headerName).toBe("agentkit");
    expect(result.challengeStatus).toBe(401);
    expect(result.finalStatus).toBe(200);
    expect(result.responseBody).toMatchObject({
      ok: true,
      mode: "local-trust-verified-signer",
      report: {
        outcome: "verified",
      },
    });
  });

  it("handles AgentKit challenges embedded in x402 payment required responses", async () => {
    const resourceUrl = "https://example.test/protected";
    let retryHeader: string | null = null;
    const fetchImpl: typeof fetch = async (_input, init) => {
      const headers = new Headers(init?.headers);
      const agentkitHeader = headers.get(AGENTKIT);
      if (!agentkitHeader) {
        return new Response(
          JSON.stringify({
            x402Version: 2,
            resource: { url: resourceUrl },
            accepts: [
              {
                scheme: "exact",
                network: "eip155:1",
                amount: "1",
                asset: "0x0000000000000000000000000000000000000000",
                payTo: "0x0000000000000000000000000000000000000000",
                maxTimeoutSeconds: 60,
                extra: {},
              },
            ],
            extensions: {
              [AGENTKIT]: createAgentkitProtectedResourceChallenge({ resourceUrl }),
            },
          }),
          {
            status: 402,
            headers: { "content-type": "application/json" },
          },
        );
      }
      retryHeader = agentkitHeader;
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    const result = await requestAgentkitProtectedResource({
      resourceUrl,
      privateKey: TEST_PRIVATE_KEY,
      fetchImpl,
    });

    expect(result.challengeStatus).toBe(402);
    expect(result.finalStatus).toBe(200);
    expect(result.challengeResourceUrl).toBe(resourceUrl);
    expect(result.headerName).toBe(AGENTKIT);
    expect(retryHeader).toEqual(expect.any(String));
  });

  it("loads a private key from a file source", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "agentkit-private-key-"));
    tempDirs.push(dir);
    const file = path.join(dir, "agentkit-private-key.txt");
    await writeFile(file, `${TEST_PRIVATE_KEY}\n`, "utf8");

    await expect(resolveAgentkitPrivateKeyValue({ privateKeyFile: file })).resolves.toBe(
      TEST_PRIVATE_KEY,
    );
  });
});
