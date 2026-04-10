import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexAppServerClient, MIN_CODEX_APP_SERVER_VERSION } from "./client.js";
import { listCodexAppServerModels } from "./models.js";
import { resetSharedCodexAppServerClientForTests } from "./shared-client.js";

function createClientHarness() {
  const stdout = new PassThrough();
  const writes: string[] = [];
  const stdin = new Writable({
    write(chunk, _encoding, callback) {
      writes.push(chunk.toString());
      callback();
    },
  });
  const process = Object.assign(new EventEmitter(), {
    stdin,
    stdout,
    stderr: new PassThrough(),
    killed: false,
    kill: vi.fn(() => {
      process.killed = true;
    }),
  });
  const client = CodexAppServerClient.fromTransportForTests(process);
  return {
    client,
    process,
    writes,
    send(message: unknown) {
      stdout.write(`${JSON.stringify(message)}\n`);
    },
  };
}

describe("shared Codex app-server client", () => {
  afterEach(() => {
    resetSharedCodexAppServerClientForTests();
    vi.restoreAllMocks();
  });

  it("closes the shared app-server when the version gate fails", async () => {
    const harness = createClientHarness();
    const startSpy = vi.spyOn(CodexAppServerClient, "start").mockReturnValue(harness.client);

    // Model discovery uses the shared-client path, which owns child teardown
    // when initialize discovers an unsupported app-server.
    const listPromise = listCodexAppServerModels({ timeoutMs: 1000 });
    const initialize = JSON.parse(harness.writes[0] ?? "{}") as { id?: number };
    harness.send({
      id: initialize.id,
      result: { userAgent: "openclaw/0.117.9 (macOS; test)" },
    });

    await expect(listPromise).rejects.toThrow(
      `Codex app-server ${MIN_CODEX_APP_SERVER_VERSION} or newer is required`,
    );
    expect(harness.process.kill).toHaveBeenCalledTimes(1);
    startSpy.mockRestore();
  });
});
