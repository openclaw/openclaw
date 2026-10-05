import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, expect, it, vi } from "vitest";
vi.mock("./app-server/transport-process-registration.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./app-server/transport-process-registration.js")>();
  return {
    ...actual,
    prepareCodexAppServerProcessRegistration: async () => async () => {},
    waitForCodexAppServerProcessRegistrationCleanup: async () => {},
  };
});
import { WebSocket } from "ws";
import { setManagedCodexPluginRoot } from "./app-server/managed-binary.js";
import { createCodexNodeWorkspaceEnvironment } from "./node-app-server-workspace-environment.js";

afterEach(() => {
  setManagedCodexPluginRoot(undefined);
  vi.restoreAllMocks();
});
let sequence = 0;
function rpc(socket: WebSocket, method: string, params: unknown) {
  const id = ++sequence;
  return new Promise<unknown>((resolve, reject) => {
    const receive = (bytes: import("ws").RawData) => {
      const data = Buffer.isBuffer(bytes)
        ? bytes
        : Array.isArray(bytes)
          ? Buffer.concat(bytes)
          : Buffer.from(bytes);
      const response = JSON.parse(data.toString());
      if (response.id !== id) {
        return;
      }
      socket.off("message", receive);
      if (response.error) {
        reject(new Error(response.error.message));
      } else {
        resolve(response.result);
      }
    };
    socket.on("message", receive);
    socket.send(JSON.stringify({ id, method, params }));
  });
}

it("keeps native initialize usable, waits for exact checkout, and refuses revoked repository operations", async () => {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "codex-repository-gate-")),
  );
  const controller = new AbortController();
  const ready = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  let status: "pending" | "ready" | "failed" = "pending";
  let current = true;
  const assertCurrent = () => {
    if (!current) {
      throw new Error("fixture owner revoked");
    }
    if (status !== "ready") {
      throw new Error("fixture repository unready");
    }
  };
  const gate = {
    assertCurrent,
    wait: async (signal: AbortSignal) => {
      entered.resolve();
      await Promise.race([
        ready.promise,
        new Promise<never>((_, reject) => {
          signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
        }),
      ]);
      assertCurrent();
    },
  };
  setManagedCodexPluginRoot(fileURLToPath(new URL("../", import.meta.url)));
  const carrier = await createCodexNodeWorkspaceEnvironment({
    workspace: { workspaceDir: root, release: () => {}, repositoryReadiness: gate },
    signal: controller.signal,
    assertExecAuthorized: () => {
      if (!current) {
        throw new Error("fixture owner revoked");
      }
    },
  });
  const socket = new WebSocket(carrier.url);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  try {
    await expect(
      rpc(socket, "initialize", { clientName: "repository-fixture" }),
    ).resolves.toHaveProperty("sessionId");
    socket.send(JSON.stringify({ method: "initialized" }));
    const file = path.join(root, "admitted.txt");
    const reading = rpc(socket, "fs/readFile", { path: pathToFileURL(file).href });
    const commandFile = path.join(root, "command-head.txt");
    const starting = rpc(socket, "process/start", {
      processId: "exact-branch-command",
      argv: [
        process.execPath,
        "-e",
        "const fs=require('node:fs');const cp=require('node:child_process');fs.writeFileSync('command-head.txt',cp.execFileSync('git',['symbolic-ref','--short','HEAD'])+cp.execFileSync('git',['rev-parse','HEAD']));",
      ],
      cwd: pathToFileURL(root).href,
      env: {},
      tty: false,
      pipeStdin: false,
      arg0: null,
    });
    await entered.promise;
    await expect(rpc(socket, "environment/info", {})).resolves.toHaveProperty("cwd");
    await expect(fs.access(file)).rejects.toThrow();
    await expect(fs.access(commandFile)).rejects.toThrow();
    const git = promisify(execFile);
    await git("git", ["init", "--initial-branch=fixture/admitted", root]);
    await fs.writeFile(file, "exact admitted checkout");
    await git("git", ["-C", root, "add", "admitted.txt"]);
    await git("git", [
      "-C",
      root,
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-m",
      "fixture",
    ]);
    const head = (await git("git", ["-C", root, "rev-parse", "HEAD"])).stdout.trim();
    status = "ready";
    ready.resolve();
    await expect(reading).resolves.toEqual({
      dataBase64: Buffer.from("exact admitted checkout").toString("base64"),
    });
    await starting;
    await rpc(socket, "process/read", {
      processId: "exact-branch-command",
      afterSeq: 0,
      waitMs: 1000,
    });
    expect(await fs.readFile(commandFile, "utf8")).toBe(`fixture/admitted\n${head}\n`);
    expect((await git("git", ["-C", root, "symbolic-ref", "--short", "HEAD"])).stdout.trim()).toBe(
      "fixture/admitted",
    );
    expect((await git("git", ["-C", root, "rev-parse", "HEAD"])).stdout.trim()).toBe(head);
    status = "failed";
    await expect(
      rpc(socket, "fs/writeFile", {
        path: pathToFileURL(file).href,
        dataBase64: Buffer.from("forbidden").toString("base64"),
      }),
    ).rejects.toThrow("operation did not run");
    expect(await fs.readFile(file, "utf8")).toBe("exact admitted checkout");
    current = false;
  } finally {
    ready.resolve();
    controller.abort();
    socket.terminate();
    await carrier.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});
