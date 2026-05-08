import { afterEach, describe, expect, it } from "vitest";
import { runAgentkitVerifierRequest } from "./verifier-request.js";
import { startAgentkitVerifierServer } from "./verifier-server.js";

const TEST_PRIVATE_KEY =
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f2b2c7e097b123" as const;

const handles: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(handles.splice(0).map((handle) => handle.close()));
});

describe("agentkit verifier server", () => {
  it("issues a challenge and accepts a locally signed verifier request", async () => {
    const handle = await startAgentkitVerifierServer({
      port: 0,
    });
    handles.push(handle);

    const discoveryResponse = await fetch(handle.info.origin);
    const discoveryBody = (await discoveryResponse.json()) as {
      protectedResourceUrl?: string;
      mode?: string;
    };
    expect(discoveryResponse.status).toBe(200);
    expect(discoveryBody.protectedResourceUrl).toBe(handle.info.protectedResourceUrl);
    expect(discoveryBody.mode).toBe("local-trust-verified-signer");

    const challengeResponse = await fetch(handle.info.protectedResourceUrl);
    const challengeBody = (await challengeResponse.json()) as {
      challenge?: { info?: { nonce?: string } };
    };
    expect(challengeResponse.status).toBe(401);
    expect(challengeBody.challenge?.info?.nonce).toBeTruthy();

    const result = await runAgentkitVerifierRequest({
      serverOrigin: handle.info.origin,
      privateKey: TEST_PRIVATE_KEY,
    });

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

  it("can use a real-style agentbook verifier instead of local trust", async () => {
    const handle = await startAgentkitVerifierServer({
      agentBook: {
        lookupHuman: async () => null,
      },
      humanLookupMode: "agentbook",
      port: 0,
    });
    handles.push(handle);
    expect(handle.info.humanLookupMode).toBe("agentbook");

    const result = await runAgentkitVerifierRequest({
      serverOrigin: handle.info.origin,
      privateKey: TEST_PRIVATE_KEY,
    });

    expect(result.challengeStatus).toBe(401);
    expect(result.finalStatus).toBe(403);
    expect(result.responseBody).toMatchObject({
      ok: false,
      report: {
        outcome: "not-human-backed",
        humanLookup: {
          mode: "agentbook",
          registered: false,
        },
      },
    });
  });
});
