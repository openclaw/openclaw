// Network fixture for the updater's public-npm channel lookup. Only use in disposable machines.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { lookup } from "node:dns/promises";
import { once } from "node:events";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { fileURLToPath } from "node:url";

export async function prepareRegistryTls(root) {
  fs.mkdirSync(root, { mode: 0o700 });
  const { address } = await lookup("registry.npmjs.org", { family: 4 });
  fs.writeFileSync(path.join(root, "public-ip"), address);
  const config = path.join(root, "openssl.cnf");
  fs.writeFileSync(
    config,
    "[req]\ndistinguished_name=dn\nx509_extensions=extensions\nprompt=no\n[dn]\nCN=registry.npmjs.org\n[extensions]\nsubjectAltName=DNS:registry.npmjs.org\nbasicConstraints=critical,CA:TRUE\n",
  );
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-sha256",
      "-days",
      "1",
      "-config",
      config,
      "-keyout",
      path.join(root, "key.pem"),
      "-out",
      path.join(root, "cert.pem"),
    ],
    { stdio: "ignore" },
  );
  fs.chmodSync(path.join(root, "key.pem"), 0o600);
}

export function mapRegistryHosts(root) {
  const hosts =
    process.platform === "win32"
      ? path.join(process.env.SystemRoot, "System32", "drivers", "etc", "hosts")
      : "/etc/hosts";
  const before = fs.readFileSync(hosts, "utf8");
  assert(
    !before.split(/\r?\n/u).some((line) =>
      line
        .split("#")[0]
        .split(/\s+/u)
        .some((alias) => alias === "registry.npmjs.org"),
    ),
    "registry hosts override already exists",
  );
  fs.writeFileSync(path.join(root, "hosts.before"), before);
  fs.appendFileSync(hosts, "\n127.0.0.1 registry.npmjs.org\n");
  fs.writeFileSync(path.join(root, "hosts.effective"), fs.readFileSync(hosts));
}

export async function startRegistryTlsRelay(
  root,
  manifest,
  registryPort,
  listenHost = "127.0.0.1",
) {
  const publicIp = fs.readFileSync(path.join(root, "public-ip"), "utf8").trim();
  const localPaths = new Set([
    "/openclaw/latest",
    ...[manifest.t, manifest.next, ...Object.values(manifest.faults ?? {})].map(
      (fixture) => `/openclaw/${fixture.version}`,
    ),
  ]);
  const server = https.createServer(
    {
      key: fs.readFileSync(path.join(root, "key.pem")),
      cert: fs.readFileSync(path.join(root, "cert.pem")),
    },
    (request, response) => {
      const local = localPaths.has(new URL(request.url, "https://registry.npmjs.org").pathname);
      const upstream = (local ? http : https).request(
        {
          hostname: local ? "127.0.0.1" : publicIp,
          port: local ? Number(registryPort) : 443,
          servername: "registry.npmjs.org",
          method: request.method,
          path: request.url,
          headers: {
            ...request.headers,
            host: local ? `127.0.0.1:${registryPort}` : "registry.npmjs.org",
          },
        },
        (reply) => {
          console.log(
            JSON.stringify({
              at: Date.now(),
              path: request.url,
              fixture: local,
              status: reply.statusCode,
            }),
          );
          response.writeHead(reply.statusCode, reply.headers);
          reply.pipe(response);
        },
      );
      upstream.on("error", (error) => {
        console.error(error);
        response.writeHead(502);
        response.end(String(error));
      });
      request.pipe(upstream);
    },
  );
  server.listen(443, listenHost);
  await once(server, "listening");
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, root, manifest, registryPort, listenHost] = process.argv.slice(2);
  assert(
    root,
    "usage: registry-tls.mjs prepare|hosts|serve CERTDIR [MANIFEST HTTP_PORT LISTEN_HOST]",
  );
  if (command === "prepare") {
    await prepareRegistryTls(root);
  } else if (command === "hosts") {
    mapRegistryHosts(root);
  } else if (command === "serve") {
    await startRegistryTlsRelay(
      root,
      JSON.parse(fs.readFileSync(manifest, "utf8")),
      registryPort,
      listenHost,
    );
    console.log("TLS fixture registry ready");
  } else {
    throw new Error("unknown registry TLS fixture command");
  }
}
