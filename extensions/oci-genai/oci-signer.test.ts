import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createOciSignedFetch, OciRequestSigner, OciSignerError } from "./oci-signer.js";
import { loadOciProfile } from "./profile-loader.js";

const FIXED_NOW_MS = Date.UTC(2026, 4, 5, 12, 34, 56); // 2026-05-05T12:34:56Z

async function buildFixtureProfile() {
  const workDir = await mkdtemp(join(tmpdir(), "oci-signer-"));
  const keyFile = join(workDir, "key.pem");
  const configFile = join(workDir, "config");

  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" });
  await writeFile(keyFile, pem);

  await writeFile(
    configFile,
    [
      "[DEFAULT]",
      "user=ocid1.user.oc1..u",
      "tenancy=ocid1.tenancy.oc1..t",
      "fingerprint=ab:cd",
      `key_file=${keyFile}`,
      "region=us-chicago-1",
    ].join("\n"),
  );

  const profile = await loadOciProfile({ configFile });
  return { profile, workDir };
}

describe("OciRequestSigner", () => {
  let workDir: string;
  let signer: OciRequestSigner;

  beforeEach(async () => {
    const fixture = await buildFixtureProfile();
    workDir = fixture.workDir;
    signer = new OciRequestSigner({
      profile: fixture.profile,
      nowMs: FIXED_NOW_MS,
    });
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("signs a POST with the body-bearing header set", async () => {
    const headers = await signer.sign({
      method: "POST",
      url: "https://inference.generativeai.us-chicago-1.oci.oraclecloud.com/openai/v1/chat/completions",
      body: '{"model":"meta.llama-3.3-70b-instruct"}',
      headers: { "content-type": "application/json" },
    });

    expect(headers.host).toBe("inference.generativeai.us-chicago-1.oci.oraclecloud.com");
    expect(headers.date).toBe(new Date(FIXED_NOW_MS).toUTCString());
    expect(headers["content-type"]).toBe("application/json");
    expect(headers["content-length"]).toBe("39");
    expect(headers["x-content-sha256"]).toBeTypeOf("string");
    expect(headers.authorization).toMatch(/^Signature version="1"/);
    expect(headers.authorization).toContain('algorithm="rsa-sha256"');
    expect(headers.authorization).toContain(
      'headers="(request-target) host date content-length content-type x-content-sha256"',
    );
    expect(headers.authorization).toContain('keyId="ocid1.tenancy.oc1..t/ocid1.user.oc1..u/ab:cd"');
  });

  it("signs a GET with the no-body header set (no content-* headers)", async () => {
    const headers = await signer.sign({
      method: "GET",
      url: "https://inference.generativeai.us-chicago-1.oci.oraclecloud.com/openai/v1/models",
    });

    expect(headers["content-length"]).toBeUndefined();
    expect(headers["content-type"]).toBeUndefined();
    expect(headers["x-content-sha256"]).toBeUndefined();
    expect(headers.authorization).toContain('headers="(request-target) host date"');
  });

  it("produces deterministic signatures for the same inputs", async () => {
    const a = await signer.sign({
      method: "POST",
      url: "https://example.com/openai/v1/chat/completions",
      body: '{"x":1}',
    });
    const b = await signer.sign({
      method: "POST",
      url: "https://example.com/openai/v1/chat/completions",
      body: '{"x":1}',
    });
    expect(a.authorization).toBe(b.authorization);
  });

  it("includes the URL search string in the request-target", async () => {
    // We can't easily extract the canonical string directly, but we can
    // confirm signing different paths yields different signatures.
    const withQuery = await signer.sign({
      method: "GET",
      url: "https://example.com/path?foo=1",
    });
    const withoutQuery = await signer.sign({
      method: "GET",
      url: "https://example.com/path",
    });
    expect(withQuery.authorization).not.toBe(withoutQuery.authorization);
  });
});

describe("createOciSignedFetch", () => {
  let workDir: string;
  let signer: OciRequestSigner;

  beforeEach(async () => {
    const fixture = await buildFixtureProfile();
    workDir = fixture.workDir;
    signer = new OciRequestSigner({
      profile: fixture.profile,
      nowMs: FIXED_NOW_MS,
    });
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("signs the outbound request and replaces a Bearer Authorization", async () => {
    let captured:
      | { url: string; headers: Record<string, string>; body: string | undefined }
      | undefined;
    const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      captured = {
        url: typeof input === "string" || input instanceof URL ? String(input) : input.url,
        headers: Object.fromEntries(new Headers(init?.headers as HeadersInit).entries()),
        body: init?.body as string | undefined,
      };
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;

    const signed = createOciSignedFetch(signer, fakeFetch);
    await signed(
      "https://inference.generativeai.us-chicago-1.oci.oraclecloud.com/openai/v1/chat/completions",
      {
        method: "POST",
        body: '{"model":"meta.llama-3.3-70b-instruct"}',
        headers: {
          "content-type": "application/json",
          Authorization: "Bearer pretend-openai-key",
        },
      },
    );

    expect(captured).toBeDefined();
    const auth = captured!.headers["authorization"];
    expect(auth).toMatch(/^Signature/);
    expect(auth).not.toMatch(/Bearer/);
  });

  it("rejects unsupported body types with OciSignerError", async () => {
    const signed = createOciSignedFetch(signer);
    await expect(
      signed("https://example.com/x", { method: "POST", body: new ReadableStream() }),
    ).rejects.toThrow(OciSignerError);
  });
});
