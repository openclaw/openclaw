import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { Agent, request, type IncomingHttpHeaders } from "node:http";
import { createSecureServer } from "node:http2";
import type { Socket } from "node:net";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function forwardedHeaders(headers: IncomingHttpHeaders): IncomingHttpHeaders {
  const excluded = new Set([
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
    ...(headers.connection?.split(",").map((name) => name.trim().toLowerCase()) ?? []),
  ]);
  return Object.fromEntries(
    Object.entries(headers).filter(([name]) => !name.startsWith(":") && !excluded.has(name)),
  );
}

/** Synthetic benchmark frontend, never a production authentication or WebSocket proxy. */
export async function startControlUiBenchProxy(upstreamUrl: string) {
  const upstream = new URL(upstreamUrl);
  if (upstream.protocol !== "http:" || upstream.hostname !== "127.0.0.1") {
    throw new Error("Control UI benchmark proxy requires a loopback HTTP upstream");
  }
  const artifactRoot = path.resolve(".artifacts/control-ui-bench-proxy");
  await mkdir(artifactRoot, { recursive: true });
  const certificateDirectory = await mkdtemp(path.join(artifactRoot, "tls-"));
  const agent = new Agent({ keepAlive: true, maxSockets: 32 });
  const sockets = new Set<Socket>();
  const pending = new Set<ReturnType<typeof request>>();
  const requests: Array<{ method: string; url: string; httpVersion: string }> = [];
  let closing: Promise<void> | undefined;
  try {
    await execFileAsync("openssl", [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      path.join(certificateDirectory, "key.pem"),
      "-out",
      path.join(certificateDirectory, "cert.pem"),
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=IP:127.0.0.1,DNS:localhost",
    ]);
    const [key, cert] = await Promise.all([
      readFile(path.join(certificateDirectory, "key.pem")),
      readFile(path.join(certificateDirectory, "cert.pem")),
    ]);
    const server = createSecureServer({ key, cert, allowHTTP1: true }, (incoming, response) => {
      requests.push({
        method: incoming.method ?? "GET",
        url: incoming.url ?? "/",
        httpVersion: incoming.httpVersion,
      });
      const outgoing = request(
        upstream,
        {
          method: incoming.method,
          path: incoming.url ?? "/",
          headers: { ...forwardedHeaders(incoming.headers), host: upstream.host },
          agent,
        },
        (upstreamResponse) => {
          response.writeHead(
            upstreamResponse.statusCode ?? 502,
            forwardedHeaders(upstreamResponse.headers),
          );
          upstreamResponse.on("error", () => response.destroy());
          upstreamResponse.pipe(response);
        },
      );
      pending.add(outgoing);
      outgoing.once("close", () => pending.delete(outgoing));
      outgoing.on("error", () => {
        if (response.headersSent) {
          response.destroy();
        } else {
          response.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
          response.end("Control UI benchmark upstream failed");
        }
      });
      incoming.on("aborted", () => outgoing.destroy());
      response.on("close", () => outgoing.destroy());
      incoming.pipe(outgoing);
    });
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
    });
    // HTTP/2 client disconnects must not become unhandled benchmark-process errors.
    server.on("sessionError", () => {});
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Control UI benchmark proxy did not bind a TCP port");
    }
    return {
      baseUrl: `https://127.0.0.1:${address.port}`,
      requests,
      close() {
        closing ??= (async () => {
          const closed = new Promise<void>((resolve, reject) => {
            server.close((error) => (error ? reject(error) : resolve()));
          });
          for (const outgoing of pending) {
            outgoing.destroy();
          }
          agent.destroy();
          for (const socket of sockets) {
            socket.destroy();
          }
          try {
            await closed;
          } finally {
            await rm(certificateDirectory, { recursive: true, force: true });
          }
        })();
        return closing;
      },
    };
  } catch (error) {
    agent.destroy();
    await rm(certificateDirectory, { recursive: true, force: true });
    throw error;
  }
}
