import { randomUUID } from "node:crypto";
import { Agent, createServer, request, type IncomingMessage } from "node:http";
import { createServer as createTcpServer } from "node:net";
import type { Duplex } from "node:stream";
import { resolveSandboxHostPort } from "../../src/agents/sandbox-host.js";
import type { GatewayAuthConfig } from "../../src/config/types.gateway.js";

const viewerEmail = "proof-operator@example.invalid";
const cookieName = "warm_reload_proof_session";

/** First free proof port; a Gateway port also needs its lazily bound sandbox port. */
export async function freeProofPort(excluded: number[] = [], gateway = false) {
  for (let port = 19600; port <= 19699; port++) {
    const ports = gateway ? [port, resolveSandboxHostPort(port)] : [port];
    if (ports.some((candidate) => candidate > 19699 || excluded.includes(candidate))) {
      continue;
    }
    const servers = ports.map(() => createTcpServer());
    try {
      for (const [index, server] of servers.entries()) {
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(ports[index], "127.0.0.1", resolve);
        });
      }
      return port;
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "EADDRINUSE") {
        throw error;
      }
    } finally {
      await Promise.all(
        servers
          .filter((server) => server.listening)
          .map(
            (server) =>
              new Promise<void>((resolve) => {
                server.close(() => resolve());
              }),
          ),
      );
    }
  }
  throw new Error("No free loopback port in 19600–19699");
}

/**
 * Synthetic proxy session only; real Gateway admission still owns every protected response.
 * `publicPort` names the browser-visible origin when another owned loopback hop forwards here.
 */
export async function startWarmReloadAdmission(options: {
  gatewayPort: number;
  port: number;
  publicPort?: number;
}) {
  const ports = [options.gatewayPort, options.port, options.publicPort ?? options.port];
  if (
    !ports.every((port) => Number.isInteger(port) && port >= 19600 && port <= 19699) ||
    ports.slice(1).includes(options.gatewayPort) ||
    (options.publicPort !== undefined && options.publicPort === options.port)
  ) {
    throw new Error(
      "Admission, its public origin, and Gateway need distinct loopback ports between 19600 and 19699",
    );
  }
  if (ports.slice(1).includes(resolveSandboxHostPort(options.gatewayPort))) {
    throw new Error("Admission cannot occupy the Gateway's native sandbox port");
  }
  const origin = `http://127.0.0.1:${ports[2]}`;
  const session = randomUUID();
  const peerSessions = [1, 2, 3].map((index) => ({
    email: `proof-viewer-${index}@example.invalid`,
    session: randomUUID(),
  }));
  const identities = new Map<string, string>([
    [session, viewerEmail],
    ...peerSessions.map((peer) => [peer.session, peer.email] as const),
  ]);
  const password = randomUUID();
  const agent = new Agent({ keepAlive: true });
  const sockets = new Set<Duplex>();
  const admitted = (req: IncomingMessage) => {
    const cookie = req.headers.cookie
      ?.split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith(`${cookieName}=`));
    return cookie ? identities.get(cookie.slice(cookieName.length + 1)) : undefined;
  };
  const forward = (req: IncomingMessage) => {
    const headers = { ...req.headers };
    for (const name of Object.keys(headers)) {
      if (
        name === "forwarded" ||
        name.startsWith("x-forwarded-") ||
        name === "x-real-ip" ||
        name === "x-openclaw-scopes" ||
        name === "authorization"
      ) {
        delete headers[name];
      }
    }
    const remainingCookies = headers.cookie
      ?.split(";")
      .map((part) => part.trim())
      .filter((part) => part.trim().split("=", 1)[0] !== cookieName)
      .join("; ");
    if (remainingCookies) {
      headers.cookie = remainingCookies;
    } else {
      delete headers.cookie;
    }
    return request({
      hostname: "127.0.0.1",
      port: options.gatewayPort,
      path: req.url,
      method: req.method,
      agent,
      headers: {
        ...headers,
        "x-forwarded-user": admitted(req),
        "x-forwarded-for": "198.51.100.248",
        "x-forwarded-proto": "http",
        "x-forwarded-host": new URL(origin).host,
      },
    });
  };
  const server = createServer((req, res) => {
    if (!admitted(req)) {
      res.writeHead(401, { "Cache-Control": "no-store" });
      res.end("Synthetic sign-in session required");
      return;
    }
    const upstream = forward(req);
    upstream.once("response", (reply) => {
      res.writeHead(reply.statusCode ?? 502, reply.headers);
      reply.pipe(res);
    });
    upstream.once("error", () => {
      if (!res.headersSent) {
        res.writeHead(502);
      }
      res.end();
    });
    req.once("aborted", () => upstream.destroy());
    req.pipe(upstream);
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  server.on("upgrade", (req, socket, head) => {
    if (!admitted(req)) {
      socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      return;
    }
    const upstream = forward(req);
    upstream.once("upgrade", (reply, remote, remoteHead) => {
      sockets.add(remote);
      remote.once("close", () => sockets.delete(remote));
      const headers = [];
      for (let index = 0; index < reply.rawHeaders.length; index += 2) {
        headers.push(`${reply.rawHeaders[index]}: ${reply.rawHeaders[index + 1]}`);
      }
      socket.write(`HTTP/1.1 101 Switching Protocols\r\n${headers.join("\r\n")}\r\n\r\n`);
      if (remoteHead.length) {
        socket.write(remoteHead);
      }
      if (head.length) {
        remote.write(head);
      }
      socket.once("error", () => remote.destroy());
      remote.once("error", () => socket.destroy());
      socket.pipe(remote).pipe(socket);
    });
    upstream.once("response", (reply) => {
      reply.resume();
      socket.end(`HTTP/1.1 ${reply.statusCode ?? 502} Rejected\r\nConnection: close\r\n\r\n`);
    });
    upstream.once("error", () => socket.destroy());
    socket.once("close", () => upstream.destroy());
    upstream.end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  return {
    origin,
    viewerEmail,
    peerSessions: peerSessions.map((peer) => ({
      email: peer.email,
      cookie: {
        name: cookieName,
        value: peer.session,
        url: origin,
        httpOnly: true,
        sameSite: "Lax" as const,
      },
    })),
    gatewayAuth: {
      mode: "trusted-proxy",
      password,
      identityScopes: Object.fromEntries(
        [viewerEmail, ...peerSessions.map((peer) => peer.email)].map((email) => [
          email,
          ["operator.admin" as const],
        ]),
      ),
      trustedProxy: {
        userHeader: "x-forwarded-user",
        requiredHeaders: ["x-forwarded-proto", "x-forwarded-host"],
        allowUsers: [viewerEmail, ...peerSessions.map((peer) => peer.email)],
        allowLoopback: true,
        deviceAutoApprove: {
          enabled: true,
          scopes: ["operator.read", "operator.write", "operator.approvals", "operator.questions"],
        },
      },
    } satisfies GatewayAuthConfig,
    browserCookie: {
      name: cookieName,
      value: session,
      url: origin,
      httpOnly: true,
      sameSite: "Lax" as const,
    },
    async close() {
      agent.destroy();
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}
