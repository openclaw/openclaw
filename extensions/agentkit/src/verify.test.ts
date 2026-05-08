import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTrustVerifiedSignerAgentBookVerifier } from "./local-agentbook.js";
import { createAgentkitProtectedResourceChallenge } from "./protected-challenge.js";
import { buildAgentkitProtectedHeader } from "./protected-header.js";
import { resolveAgentkitHeaderValue, verifyAgentkitHeader } from "./verify.js";

const TEST_PRIVATE_KEY =
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f2b2c7e097b123" as const;
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("agentkit verifier", () => {
  it("verifies a locally signed protected-resource header", async () => {
    const challenge = createAgentkitProtectedResourceChallenge({
      resourceUrl: "http://127.0.0.1:4123/protected",
      now: new Date(),
    });
    const signed = await buildAgentkitProtectedHeader({
      challenge,
      privateKey: TEST_PRIVATE_KEY,
    });

    const report = await verifyAgentkitHeader({
      header: signed.header,
      resourceUrl: challenge.info.uri,
      agentBook: createTrustVerifiedSignerAgentBookVerifier(),
      humanLookupMode: "local-trust-verified-signer",
    });

    expect(report.outcome).toBe("verified");
    expect(report.signatureValidation.valid).toBe(true);
    expect(report.signatureValidation.address).toBe(signed.address);
    expect(report.humanLookup.humanId).toBe(`local-human:${signed.address.toLowerCase()}`);
    expect(report.payload?.chainId).toBe("eip155:480");
  });

  it("rejects a valid header when the protected resource URL does not match", async () => {
    const challenge = createAgentkitProtectedResourceChallenge({
      resourceUrl: "http://127.0.0.1:4123/protected",
      now: new Date(),
    });
    const signed = await buildAgentkitProtectedHeader({
      challenge,
      privateKey: TEST_PRIVATE_KEY,
    });

    const report = await verifyAgentkitHeader({
      header: signed.header,
      resourceUrl: "http://127.0.0.1:4999/protected",
      agentBook: createTrustVerifiedSignerAgentBookVerifier(),
      humanLookupMode: "local-trust-verified-signer",
    });

    expect(report.outcome).toBe("invalid-message");
    expect(report.messageValidation.error).toContain("URI mismatch");
  });

  it("loads a header from a file source", async () => {
    const challenge = createAgentkitProtectedResourceChallenge({
      resourceUrl: "http://127.0.0.1:4123/protected",
      now: new Date(),
    });
    const signed = await buildAgentkitProtectedHeader({
      challenge,
      privateKey: TEST_PRIVATE_KEY,
    });
    const dir = await mkdtemp(path.join(os.tmpdir(), "agentkit-header-"));
    tempDirs.push(dir);
    const file = path.join(dir, "agentkit-header.txt");
    await writeFile(file, `${signed.header}\n`, "utf8");

    await expect(resolveAgentkitHeaderValue({ headerFile: file })).resolves.toBe(signed.header);
  });

  it("reports not-human-backed when AgentBook does not recognize the signer", async () => {
    const challenge = createAgentkitProtectedResourceChallenge({
      resourceUrl: "http://127.0.0.1:4123/protected",
      now: new Date(),
    });
    const signed = await buildAgentkitProtectedHeader({
      challenge,
      privateKey: TEST_PRIVATE_KEY,
    });

    const report = await verifyAgentkitHeader({
      header: signed.header,
      resourceUrl: challenge.info.uri,
      agentBook: {
        lookupHuman: async () => null,
      },
      humanLookupMode: "agentbook",
    });

    expect(report.outcome).toBe("not-human-backed");
    expect(report.signatureValidation.valid).toBe(true);
    expect(report.humanLookup.mode).toBe("agentbook");
    expect(report.humanLookup.registered).toBe(false);
  });

  it("reports agent-book-error when human lookup fails unexpectedly", async () => {
    const challenge = createAgentkitProtectedResourceChallenge({
      resourceUrl: "http://127.0.0.1:4123/protected",
      now: new Date(),
    });
    const signed = await buildAgentkitProtectedHeader({
      challenge,
      privateKey: TEST_PRIVATE_KEY,
    });

    const report = await verifyAgentkitHeader({
      header: signed.header,
      resourceUrl: challenge.info.uri,
      agentBook: {
        lookupHuman: async () => {
          throw new Error("rpc unavailable");
        },
      },
      humanLookupMode: "agentbook",
    });

    expect(report.outcome).toBe("agent-book-error");
    expect(report.humanLookup.error).toContain("rpc unavailable");
  });
});
