import { once } from "node:events";
import { chmod, realpath } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { inspect } from "node:util";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, expect, it } from "vitest";
import { signalRpcRequest } from "./client.js";
import { useSignalHttpServer } from "./client.test-support.js";

const http = useSignalHttpServer();
const dirs = useAutoCleanupTempDirTracker(afterEach);
const token = "synthetic-proof-token";
const cases = [
  {
    label: "rate limit",
    retry: 45,
    captcha: false,
    results: [
      { type: "RATE_LIMIT_FAILURE", retryAfterSeconds: 15 },
      { type: "RATE_LIMIT_FAILURE", retryAfterSeconds: 45 },
    ],
  },
  {
    label: "proof required",
    retry: 60,
    captcha: true,
    results: [{ type: "RATE_LIMIT_FAILURE", retryAfterSeconds: 60, token }],
  },
  {
    label: "zero delay and invalid values",
    retry: 0,
    captcha: false,
    results: [
      { type: "RATE_LIMIT_FAILURE", retryAfterSeconds: 0 },
      { type: "RATE_LIMIT_FAILURE", retryAfterSeconds: -1 },
      { type: "RATE_LIMIT_FAILURE", retryAfterSeconds: "90" },
      { type: "NETWORK_FAILURE", retryAfterSeconds: 999 },
    ],
  },
  { label: "malformed results", retry: undefined, captcha: false, results: null },
];

for (const transport of ["http", "unix"] as const) {
  it.skipIf(transport === "unix" && process.platform === "win32").each(cases)(
    `${transport} retains $label details without logging tokens or replaying`,
    async ({ retry, captcha, results }) => {
      const data = { response: { timestamp: 1700000000000, results } };
      const failure = {
        code: -4,
        message: captcha ? `Proof required: ${token}` : "Rate limited",
        data,
      };
      let requests = 0;
      let baseUrl: string;
      let server: net.Server | undefined;
      if (transport === "http") {
        baseUrl = await http((_req, res) => {
          requests += 1;
          res.end(JSON.stringify({ jsonrpc: "2.0", error: failure }));
        });
      } else {
        const dir = dirs.make("signal-error-", await realpath(os.tmpdir()));
        await chmod(dir, 0o700);
        const socketPath = path.join(dir, "rpc.sock");
        server = net.createServer((socket) => {
          socket.once("data", (chunk) => {
            requests += 1;
            const { id } = JSON.parse(chunk.toString());
            socket.end(JSON.stringify({ jsonrpc: "2.0", id, error: failure }) + "\n");
          });
        });
        server.listen(socketPath);
        await once(server, "listening");
        baseUrl = pathToFileURL(socketPath).href.replace(/^file:/, "unix:");
      }
      try {
        const error = await signalRpcRequest("send", { message: "hello" }, { baseUrl }).catch(
          (caught: unknown) => caught,
        );
        expect(error).toBeInstanceOf(Error);
        expect(error).toMatchObject({
          code: -4,
          retryAfterSeconds: retry,
          hasCaptchaChallenge: captcha,
        });
        expect(error).toHaveProperty("data", data);
        const text = String(error);
        if (retry !== undefined) {
          expect(text).toContain(`retryAfterSeconds=${retry}`);
        }
        if (captcha) {
          expect(text).toContain("captcha challenge present");
        }
        for (const logged of [text, JSON.stringify(error), inspect(error)]) {
          expect(logged).not.toContain(token);
        }
        expect(requests).toBe(1);
      } finally {
        if (server) {
          await server[Symbol.asyncDispose]();
        }
      }
    },
  );
}
