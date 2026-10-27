import { randomUUID } from "node:crypto";
import { Agent, createServer, request, type IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { resolveSandboxHostPort } from "../../src/agents/sandbox-host.js";
import type { GatewayAuthConfig } from "../../src/config/types.gateway.js";

const viewerEmail = "proof-operator@example.invalid";
const cookieName = "warm_reload_proof_session";

/** Synthetic proxy session only; real Gateway admission still owns every protected response. */
export async function startWarmReloadAdmission(options: { gatewayPort: number; port: number }) {
  if (
    ![options.gatewayPort, options.port].every(
      (port) => Number.isInteger(port) && port >= 19600 && port <= 19699,
    ) ||
    options.gatewayPort === options.port
  ) {
    throw new Error("Admission and Gateway need distinct loopback ports between 19600 and 19699");
  }
  if (options.port === resolveSandboxHostPort(options.gatewayPort)) {
    throw new Error("Admission cannot occupy the Gateway's native sandbox port");
  }
  const origin = `http://127.0.0.1:${options.port}`;
  const session = randomUUID();
  const password = randomUUID();
  const agent = new Agent({ keepAlive: true });
  const sockets = new Set<Duplex>();
  const admitted = (req: IncomingMessage) =>
    req.headers.cookie?.split(";").some((part) => part.trim() === `${cookieName}=${session}`) ===
    true;
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
        "x-forwarded-user": viewerEmail,
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
    gatewayAuth: {
      mode: "trusted-proxy",
      password,
      identityScopes: { [viewerEmail]: ["operator.admin"] },
      trustedProxy: {
        userHeader: "x-forwarded-user",
        requiredHeaders: ["x-forwarded-proto", "x-forwarded-host"],
        allowUsers: [viewerEmail],
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
