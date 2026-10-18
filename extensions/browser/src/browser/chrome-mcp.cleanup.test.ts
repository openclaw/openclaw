import childProcess, { type ChildProcess } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import net, { type Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { setImmediate } from "node:timers/promises";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createChromeMcpSession } from "./chrome-mcp-connect.js";
import type { ChromeMcpSession } from "./chrome-mcp-contracts.js";
import { getChromeMcpSessionOwner } from "./chrome-mcp-session.js";
import { setChromeMcpSessionFactoryForTest } from "./chrome-mcp.test-support.js";

const { mockChromeMcpProcesses, resetChromeMcpProcessMocks } = await vi.hoisted(
  () => import("./chrome-mcp-process.test-support.js"),
);

vi.mock("openclaw/plugin-sdk/logging-core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/logging-core")>()),
  createSubsystemLogger: () => ({ child: () => ({ warn: vi.fn() }) }),
}));

let disposePeer: (() => Promise<void>) | undefined;
afterEach(async () => {
  try {
    await disposePeer?.();
  } finally {
    disposePeer = undefined;
    resetChromeMcpProcessMocks();
    setChromeMcpSessionFactoryForTest(null);
    vi.restoreAllMocks();
  }
});

async function heldStdioPeer({
  earlyDescendant = false,
  releaseCapture,
}: {
  earlyDescendant?: boolean;
  releaseCapture?: () => void;
} = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "chrome-mcp-cleanup-")));
  const script = path.join(root, "peer.mjs");
  const sockets = new Set<Socket>();
  const socketClosures: Promise<void>[] = [];
  const connected = new Map<string, Socket>();
  const waiters = new Map<string, (socket: Socket) => void>();
  const waitFor = (event: string) => {
    const socket = connected.get(event);
    return socket
      ? Promise.resolve(socket)
      : new Promise<Socket>((resolve) => {
          waiters.set(event, resolve);
        });
  };
  const server = net.createServer((socket) => {
    sockets.add(socket);
    const closed = createDeferred<void>();
    socketClosures.push(closed.promise);
    socket.once("close", () => closed.resolve());
    socket.once("close", () => sockets.delete(socket));
    socket.on("error", () => {}); // The owned peer may exit while teardown sends its release.
    if (disposing) {
      socket.end("release\n");
    }
    createInterface({ input: socket }).on("line", (event) => {
      connected.set(event, socket);
      waiters.get(event)?.(socket);
    });
  });
  let child: ChildProcess | undefined;
  let childClosed: Promise<unknown> | undefined;
  const resources: { session?: ChromeMcpSession } = {};
  let disposing: Promise<void> | undefined;
  const options = { command: process.execPath, args: [script] };
  const owner = getChromeMcpSessionOwner("cleanup-fixture", options);
  const dispose = () =>
    (disposing ??= (async () => {
      releaseCapture?.();
      // This independent fixture channel releases only these exact peers, including
      // an untracked descendant when testing a deliberately failed process census.
      for (const socket of sockets) {
        socket.end("release\n");
      }
      const session = resources.session;
      await (session && owner.close(session).catch(() => {}));
      await childClosed;
      await Promise.all(socketClosures);
      // Discard uncertain state only after the independent channel closed every peer.
      if (session) {
        session.processCleanup = { status: "closed" };
        await owner.close(session);
      }
      if (server.listening) {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
      }
      await fs.rm(root, { recursive: true, force: true });
    })());
  disposePeer = dispose;
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Missing fixture listener");
  }
  await fs.writeFile(
    script,
    `import { spawn } from "node:child_process";
import net from "node:net";
import { createInterface } from "node:readline";
const control = net.connect(${address.port}, "127.0.0.1");
const descendant = process.argv[2] === "descendant";
control.on("connect", () => {
  control.write((descendant ? "descendant" : "root") + "\\n");
  if (descendant) process.send("ready");
});
control.on("data", () => process.exit(0));
control.on("close", () => process.exit(0));
if (!descendant) {
  const spawnDescendant = (ready) => {
    const child = spawn(process.execPath, [${JSON.stringify(script)}, "descendant"], {
      stdio: ["ignore", ${earlyDescendant ? '"ignore", "ignore"' : '"inherit", "inherit"'}, "ipc"],
    });
    child.once("message", () => { child.disconnect(); ready(); });
  };
  if (${earlyDescendant}) spawnDescendant(() => control.write("early-descendant-ready\\n"));
  const input = createInterface({ input: process.stdin });
  input.on("line", (line) => {
    const request = JSON.parse(line);
    if (request.method !== "initialize") return;
    control.write("initialize\\n");
    spawnDescendant(() => {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id,
        error: { code: -32000, message: "fixture initialization failed" } }) + "\\n");
    });
  });
  input.on("close", () => control.write("stdin-ended\\n"));
}
`,
  );
  const spawn = childProcess.spawn;
  vi.spyOn(childProcess, "spawn").mockImplementation((...args: Parameters<typeof spawn>) => {
    const spawned = spawn(...args);
    if (args[0] === process.execPath && Array.isArray(args[1]) && args[1][0] === script) {
      child = spawned;
      childClosed = once(spawned, "close");
    }
    return spawned;
  });
  const session = createChromeMcpSession(owner, "cleanup-fixture", options);
  resources.session = session;
  if (!child) {
    throw new Error("SDK did not spawn the fixture child");
  }
  return {
    session,
    owner,
    options,
    events: connected,
    exactChild: child,
    exited: once(child, "exit"),
    closed: childClosed,
    waitFor,
  };
}

function holdProcessCensus(fail = false) {
  const started = createDeferred<void>();
  const release = createDeferred<void>();
  mockChromeMcpProcesses({
    afterCensus: async () => {
      started.resolve();
      await release.promise;
      if (fail) {
        throw new Error("fixture process census failed");
      }
    },
  });
  return { started: started.promise, release: release.resolve };
}

function forbidReplacement() {
  const factory = vi.fn(() => {
    throw new Error("replacement admitted");
  });
  setChromeMcpSessionFactoryForTest(factory);
  return factory;
}

// POSIX keeps the exact SDK child alive at EOF; Windows deliberately taskkills the tree first.
describe.skipIf(process.platform === "win32")("Chrome MCP SDK-initiated cleanup", () => {
  it("joins failed initialization and fences an ephemeral replacement", async () => {
    const fixture = await heldStdioPeer();
    const { session, owner, exactChild } = fixture;
    let settled = 0;
    const readiness = session.ready.finally(() => settled++);
    void readiness.catch(() => {});
    const rootControl = await fixture.waitFor("stdin-ended");
    await fixture.waitFor("descendant");
    expect([exactChild.exitCode, session.transport.pid]).toEqual([null, null]);
    const cleanup = Promise.all(
      [owner.close(session), session.client.close(), session.transport.close()].map((closing) =>
        closing.finally(() => settled++),
      ),
    );
    void cleanup.catch(() => {});
    const replacementFactory = forbidReplacement();
    const replacement = getChromeMcpSessionOwner("cleanup-fixture", fixture.options).lease({
      ephemeral: true,
    });
    const replacementResult = expect(replacement).rejects.toThrow("replacement admitted");
    await setImmediate();
    expect(settled, "readiness and all closes join the live child").toBe(0);
    expect(replacementFactory).not.toHaveBeenCalled();
    expect(session.processCleanup).toMatchObject({
      status: "tracked",
      target: { root: { pid: exactChild.pid }, descendants: [expect.any(Object)] },
    });
    rootControl.end("release\n");
    await fixture.exited;
    await cleanup;
    await fixture.closed;
    await expect(readiness).rejects.toThrow("fixture initialization failed");
    expect(settled).toBe(4);
    await replacementResult;
    expect(replacementFactory).toHaveBeenCalledOnce();
    expect(session.processCleanup?.status).toBe("closed");
    expect(exactChild.exitCode).toBe(0);
    expect((await fixture.waitFor("descendant")).destroyed).toBe(true);
  });

  it("does not admit initialize after close interrupts the initial process snapshot", async () => {
    const scan = holdProcessCensus();
    const { session, owner, waitFor, events } = await heldStdioPeer({
      releaseCapture: scan.release,
    });
    await Promise.race([scan.started, session.ready]);
    const closing = owner.close(session);
    void closing.catch(() => {});
    scan.release();
    const rootControl = await waitFor("stdin-ended");
    rootControl.end("release\n");
    await closing;
    expect([events.has("initialize"), events.has("descendant")]).toEqual([false, false]);
    await expect(session.ready).rejects.toThrow("Chrome MCP session is closing");
    expect(session.processCleanup?.status).toBe("closed");
  });

  it("retains failed initial capture after the child exits with an untracked descendant", async () => {
    const scan = holdProcessCensus(true);
    const fixture = await heldStdioPeer({
      earlyDescendant: true,
      releaseCapture: scan.release,
    });
    const { session, owner, waitFor, events } = fixture;
    await scan.started;
    await waitFor("early-descendant-ready");
    const rootControl = await waitFor("root");
    const descendantControl = await waitFor("descendant");
    rootControl.end("release\n");
    await fixture.closed;
    scan.release();
    await session.ready.catch(() => {});
    expect(events.has("initialize")).toBe(false);
    expect(session).toMatchObject({
      transport: { pid: null },
      processCleanup: { status: "uncertain" },
    });
    expect(descendantControl.destroyed).toBe(false);
    const error = "subprocess tree cleanup could not be verified";
    await expect(session.ready).rejects.toThrow(error);
    await expect(owner.close(session)).rejects.toThrow(error);
    const replacementFactory = forbidReplacement();
    await expect(
      getChromeMcpSessionOwner("cleanup-fixture", fixture.options).lease({}),
    ).rejects.toThrow(error);
    expect(replacementFactory).not.toHaveBeenCalled();
  });
});

it("settles cleanup after native argument validation fails without a child", async () => {
  const options = { command: process.execPath, args: ["\0"] };
  const owner = getChromeMcpSessionOwner("failed-spawn", options);
  const session = createChromeMcpSession(owner, "failed-spawn", options);
  await expect(session.ready).rejects.toThrow();
  await owner.close(session);
  expect(session).toMatchObject({ processCleanup: { status: "closed" }, transport: { pid: null } });
});
