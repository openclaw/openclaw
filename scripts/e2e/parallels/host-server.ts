import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { exists } from "./filesystem.ts";
import { die, run, say, sh, warn } from "./host-command.ts";
import type { HostServer } from "./types.ts";

export function resolveHostIp(explicit = ""): string {
  if (explicit) {
    return explicit;
  }
  const output = sh("ifconfig | awk '/inet 10\\.211\\./ { print $2; exit }'", {
    quiet: true,
  }).stdout.trim();
  if (!output) {
    die("failed to detect Parallels host IP; pass --host-ip");
  }
  return output;
}

export function allocateHostPort(): number {
  return Number(
    run(
      "python3",
      [
        "-c",
        "import socket; s=socket.socket(); s.bind(('0.0.0.0', 0)); print(s.getsockname()[1]); s.close()",
      ],
      { quiet: true },
    ).stdout.trim(),
  );
}

export async function isHostPortFree(port: number): Promise<boolean> {
  return await new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "0.0.0.0", () => {
      server.close(() => resolve(true));
    });
  });
}

export async function resolveHostPort(
  port: number,
  explicit: boolean,
  defaultPort: number,
): Promise<number> {
  if (await isHostPortFree(port)) {
    return port;
  }
  if (explicit) {
    die(`host port ${port} already in use`);
  }
  const allocated = allocateHostPort();
  warn(`host port ${defaultPort} busy; using ${allocated}`);
  return allocated;
}

export async function startHostServer(input: {
  dir: string;
  hostIp: string;
  port: number;
  artifactPath: string;
  label: string;
}): Promise<HostServer> {
  const artifactName = path.basename(input.artifactPath);
  const server = createServer(async (request, response) => {
    const requestPath = decodeURIComponent(
      new URL(request.url ?? "/", "http://127.0.0.1").pathname,
    );
    const fileName = path.basename(requestPath);
    const filePath = path.join(input.dir, fileName);
    if (fileName !== artifactName && !(await exists(filePath))) {
      response.statusCode = 404;
      response.end("not found");
      return;
    }
    try {
      const info = await stat(filePath);
      response.setHeader("Content-Length", String(info.size));
      response.setHeader("Content-Type", "application/octet-stream");
      createReadStream(filePath).pipe(response);
    } catch {
      response.statusCode = 404;
      response.end("not found");
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(input.port, "0.0.0.0", () => resolve());
  });
  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : input.port;
  say(`Serve ${input.label} on ${input.hostIp}:${actualPort}`);
  return {
    hostIp: input.hostIp,
    port: actualPort,
    stop: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
    urlFor: (filePath) =>
      `http://${input.hostIp}:${actualPort}/${encodeURIComponent(path.basename(filePath))}`,
  };
}
