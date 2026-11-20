import { execFile } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { setManagedCodexPluginRoot } from "./app-server/managed-binary.js";
import { createCodexNodeWorkspaceEnvironment } from "./node-app-server-workspace-environment.js";
vi.mock("./app-server/transport-process-registration.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./app-server/transport-process-registration.js")>()),
  prepareCodexAppServerProcessRegistration: async () => async () => {},
  waitForCodexAppServerProcessRegistrationCleanup: async () => {},
}));
import { createCodexNodeGitHubCredential } from "./node-github-credential.js";

const execFileAsync = promisify(execFile);

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  setManagedCodexPluginRoot(undefined);
});

it.each([
  { host: "github.com", key: "GH_TOKEN", other: "GH_ENTERPRISE_TOKEN" },
  { host: "microsoft.ghe.com", key: "GH_TOKEN", other: "GH_ENTERPRISE_TOKEN" },
  { host: "github.example.test", key: "GH_ENTERPRISE_TOKEN", other: "GH_TOKEN" },
] as const)(
  "installs a private same-host profile and pins each command's current token on $host",
  async ({ host, key, other }) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-node-github-"));
    let active = true;
    try {
      const credential = await createCodexNodeGitHubCredential({
        profileDir: path.join(root, "profile"),
        binding: { host, login: "test-app[bot]", token: "synthetic-initial" },
        assertCurrent() {
          if (!active) {
            throw new Error("turn closed");
          }
        },
      });
      for (const [url, expected] of [
        [`https://${host}/owner/repository`, "!gh auth git-credential"],
        ["https://unrelated.example.test/owner/repository", ""],
      ] as const) {
        const { stdout } = await execFileAsync(
          "git",
          ["config", "--get-urlmatch", "credential.helper", url],
          {
            cwd: root,
            env: {
              ...process.env,
              ...credential.launchEnvironment(),
              GIT_CONFIG_GLOBAL: path.join(root, "absent-gitconfig"),
              GIT_CONFIG_NOSYSTEM: "1",
            },
          },
        );
        expect(stdout.trim()).toBe(expected);
      }
      expect(Object.values(credential.environment)).not.toContain("synthetic-initial");
      const firstCommand = credential.launchEnvironment();
      const update = {
        generation: 1,
        token: "synthetic-renewed",
        expiresAtMs: Date.now() + 60_000,
      };
      expect(await credential.install(update)).toEqual({ generation: 1 });
      expect(await credential.install(update)).toEqual({ generation: 1 });
      const hosts = await fs.readFile(path.join(root, "profile", "hosts.yml"), "utf8");
      expect(hosts).toContain(host);
      expect(hosts).toContain("synthetic-renewed");
      expect(hosts).not.toContain("synthetic-initial");
      if (process.platform !== "win32") {
        expect((await fs.stat(path.join(root, "profile", "hosts.yml"))).mode & 0o077).toBe(0);
      }
      expect(firstCommand[key]).toBe("synthetic-initial");
      expect(credential.launchEnvironment()).toMatchObject({
        [key]: "synthetic-renewed",
        [other]: "",
        GH_HOST: host,
      });
      await expect(credential.install({ ...update, token: "synthetic-conflict" })).rejects.toThrow(
        "generation changed",
      );
      await expect(
        credential.install({ ...update, generation: 2, host: "other.test" }),
      ).rejects.toThrow("invalid");
      active = false;
      await expect(credential.install({ ...update, generation: 2 })).rejects.toThrow("turn closed");
      expect(() => credential.launchEnvironment()).toThrow("turn closed");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  },
);

async function verifyCommandEnvironment(kind: "github" | "custom", signal: AbortSignal) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "codex-node-renewal-")));
  const controller = new AbortController();
  const active = AbortSignal.any([signal, controller.signal]);
  let environment: Awaited<ReturnType<typeof createCodexNodeWorkspaceEnvironment>> | undefined;
  let socket: WebSocket | undefined;
  try {
    const credential =
      kind === "github"
        ? await createCodexNodeGitHubCredential({
            profileDir: path.join(root, "github"),
            binding: {
              host: "microsoft.ghe.com",
              login: "test-app[bot]",
              token: "synthetic-initial",
            },
            assertCurrent: () => active.throwIfAborted(),
          })
        : undefined;
    setManagedCodexPluginRoot(fileURLToPath(new URL("../", import.meta.url)));
    vi.stubEnv("OPENCLAW_STATE_DIR", path.join(root, "state"));
    let commandToken = "synthetic-initial";
    const commandEnvironment = credential ?? {
      environment: { CALLER_CONTEXT: "isolated-caller" },
      launchEnvironment() {
        active.throwIfAborted();
        return { CALLER_CONTEXT: "isolated-caller", CALLER_TOKEN: commandToken };
      },
    };
    environment = await createCodexNodeWorkspaceEnvironment({
      workspace: { workspaceDir: root, release() {} },
      signal: active,
      assertExecAuthorized: () => active.throwIfAborted(),
      commandEnvironment,
    });
    socket = new WebSocket(environment.url);
    const messages: Array<Record<string, unknown>> = [];
    let changed = () => {};
    socket.on("message", (data) => {
      const bytes = Buffer.isBuffer(data)
        ? data
        : Array.isArray(data)
          ? Buffer.concat(data)
          : Buffer.from(data);
      messages.push(JSON.parse(bytes.toString("utf8")) as Record<string, unknown>);
      changed();
    });
    await once(socket, "open", { signal });
    const stopped = AbortSignal.any([signal, environment.signal]);
    const take = async (
      matches: (message: Record<string, unknown>) => boolean,
    ): Promise<Record<string, unknown>> => {
      while (true) {
        stopped.throwIfAborted();
        const index = messages.findIndex(matches);
        if (index !== -1) {
          return messages.splice(index, 1)[0]!;
        }
        await new Promise<void>((resolve, reject) => {
          const abort = () =>
            reject(stopped.reason instanceof Error ? stopped.reason : new Error("proof closed"));
          stopped.addEventListener("abort", abort, { once: true });
          changed = () => {
            stopped.removeEventListener("abort", abort);
            resolve();
          };
        });
      }
    };
    socket.send(
      JSON.stringify({
        id: 1,
        method: "initialize",
        params: { clientName: "openclaw-renewal-proof" },
      }),
    );
    expect(await take((message) => message.id === 1)).toHaveProperty("result");
    socket.send(JSON.stringify({ method: "initialized", params: {} }));
    for (const [index, expected] of ["synthetic-initial", "synthetic-renewed"].entries()) {
      if (index === 1) {
        commandToken = expected;
        await credential?.install({
          generation: 1,
          token: expected,
          expiresAtMs: Date.now() + 60_000,
        });
      }
      const processId = `renewal-${index}`;
      socket.send(
        JSON.stringify({
          id: index + 2,
          method: "process/start",
          params: {
            processId,
            argv: [
              process.execPath,
              "-e",
              kind === "github"
                ? "process.stdout.write(JSON.stringify({token:process.env.GH_TOKEN,other:process.env.GH_ENTERPRISE_TOKEN,host:process.env.GH_HOST}))"
                : "process.stdout.write(JSON.stringify({token:process.env.CALLER_TOKEN,context:process.env.CALLER_CONTEXT}))",
            ],
            cwd: pathToFileURL(root).href,
            env: {
              GH_TOKEN: "stale",
              GH_ENTERPRISE_TOKEN: "other-host",
              GH_HOST: "other.test",
              CALLER_TOKEN: "stale",
            },
            tty: false,
            pipeStdin: false,
            arg0: null,
          },
        }),
      );
      expect(await take((message) => message.id === index + 2)).toHaveProperty("result");
      const output = await take((message) => message.method === "process/output");
      expect(output).toMatchObject({
        params: {
          processId,
          chunk: Buffer.from(
            JSON.stringify(
              kind === "github"
                ? { token: expected, other: "", host: "microsoft.ghe.com" }
                : { token: expected, context: "isolated-caller" },
            ),
          ).toString("base64"),
        },
      });
      await take((message) => message.method === "process/closed");
    }
  } finally {
    controller.abort(new Error("isolated proof complete"));
    socket?.terminate();
    await environment?.close();
    await fs.rm(root, { recursive: true, force: true });
  }
}

it.for(["github", "custom"] as const)(
  "refreshes caller-owned %s credentials in the connected native execution environment",
  async (kind, { signal }) => {
    await verifyCommandEnvironment(kind, signal);
  },
);
