import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:https";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { invokeRemoteNativeHookRelay } from "./native-hook-relay-remote-client.js";

it("verifies TLS and sends only the relay capability; refuses redirects and bounds responses", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "native-hook-https-"));
  const originalCAs = tls.getCACertificates("default");
  let received = 0;
  const requests: Promise<void>[] = [];
  let mode = "ok";
  let status = 200;
  await promisify(execFile)("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-days",
    "1",
    "-subj",
    "/CN=localhost",
    "-addext",
    "subjectAltName=IP:127.0.0.1",
    "-keyout",
    path.join(dir, "key.pem"),
    "-out",
    path.join(dir, "cert.pem"),
  ]);
  const cert = await readFile(path.join(dir, "cert.pem"), "utf8");
  const server = createServer(
    { key: await readFile(path.join(dir, "key.pem")), cert },
    (req, res) => {
      const request = (async () => {
        received++;
        expect(req.headers.authorization).toBe("Bearer synthetic-relay-capability");
        expect(req.url).toBe("/__openclaw__/native-hook/relay");
        const chunks = [];
        for await (const chunk of req) {
          chunks.push(chunk);
        }
        expect(JSON.parse(Buffer.concat(chunks).toString())).toMatchObject({
          generation: "current",
          relayId: "relay",
        });
        if (mode === "hang") {
          return;
        }
        res.writeHead(status, { location: "https://127.0.0.1/never-follow" });
        res.end(
          mode === "large"
            ? "x".repeat(1024 * 1024 + 1)
            : JSON.stringify({ ok: true, result: { stdout: "allow", stderr: "", exitCode: 0 } }),
        );
      })();
      requests.push(request);
      void request.catch(() => res.destroy());
    },
  );
  try {
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("missing address");
    }
    const url = `https://127.0.0.1:${address.port}/__openclaw__/native-hook/relay`;
    const credential = path.join(dir, "credential.json");
    const save = (target: string) =>
      writeFile(credential, JSON.stringify({ url: target, token: "synthetic-relay-capability" }));
    const invoke = (signal = AbortSignal.timeout(5_000)) =>
      invokeRemoteNativeHookRelay(
        credential,
        {
          provider: "codex",
          relayId: "relay",
          generation: "current",
          event: "pre_tool_use",
          rawPayload: {},
        },
        signal,
      );
    await save(url);
    await expect(invoke()).rejects.toThrow("connection failed");
    expect(received).toBe(0);
    tls.setDefaultCACertificates([...originalCAs, cert]);
    await expect(invoke()).resolves.toMatchObject({ stdout: "allow", exitCode: 0 });
    status = 302;
    await expect(invoke()).rejects.toThrow("rejected (302)");
    expect(received).toBe(2);
    status = 200;
    mode = "large";
    await expect(invoke()).rejects.toThrow("response too large");
    mode = "hang";
    await expect(invoke(AbortSignal.timeout(30))).rejects.toThrow("connection failed");
    await save(url.replace("https:", "http:"));
    await expect(invoke()).rejects.toThrow("requires an HTTPS URL");
    await save(url + "?token=untrusted");
    await expect(invoke()).rejects.toThrow("requires an HTTPS URL");
    await writeFile(credential, '{"token":"synthetic-relay-capability",invalid}');
    await expect(invoke()).rejects.toThrow("Invalid native hook callback credential");
    await Promise.all(requests);
  } finally {
    tls.setDefaultCACertificates(originalCAs);
    server.closeAllConnections();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    await rm(dir, { recursive: true, force: true });
  }
}, 15_000);
