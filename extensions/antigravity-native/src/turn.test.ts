import { mkdtemp, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  closeOwnedStdioProcess,
  OwnedStdioCleanupError,
} from "openclaw/plugin-sdk/process-runtime";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/sandbox";
import { describe, expect, it, vi } from "vitest";
import { runBoundAgyTurn, type AgySessionBinding } from "./bound-turn.js";
import { runAgyTurn } from "./turn.js";

vi.mock("openclaw/plugin-sdk/process-runtime", async (importOriginal) => {
  const sdk = await importOriginal<typeof import("openclaw/plugin-sdk/process-runtime")>();
  return { ...sdk, closeOwnedStdioProcess: vi.fn(sdk.closeOwnedStdioProcess) };
});

const expectedId = "8c3857ae-d629-42c3-896c-b1254237101e";
const replacementId = "6a32b160-a8cd-4dfd-9530-81542943f744";
const model = "gemini-3.8-flash-low";
const prompt = "Known private test prompt";

const fixture = String.raw`
const fs = require("node:fs");
const [mode, exact, other, model] = process.argv.slice(1);
const id = mode === "replacement" ? other : exact;
const write = (object) => process.stdout.write(JSON.stringify(object) + "\n");
write({event: "init", conversation_id: id, init: {model: mode === "wrong-model" ? "wrong" : model}});
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  fs.writeFileSync("received", "started");
  input += chunk;
});
process.stdin.on("end", () => {
  if (JSON.parse(input).message.content !== "Known private test prompt") process.exit(31);
  if (mode === "silent-tool") {
    const tool = require("node:child_process").spawn(process.execPath, ["-e",
      'process.send("started"); setTimeout(() => require("node:fs").writeFileSync("delayed", "should not run"), 1200);',
    ], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
    tool.once("message", () => write({event: "step_update", step_update: {
      conversation_id: exact, step_type: "agent_response", state: "ACTIVE", text_delta: "Tool started",
    }}));
    return;
  }
  write({event: "step_update", step_update: {conversation_id: exact, step_type: "agent_response", state: "ACTIVE", text_delta: "Pong"}});
  write({event: "step_update", step_update: {conversation_id: exact, step_type: "agent_response", state: "DONE", text_delta: "!", usage: {input_tokens: 3, output_tokens: 1, cache_read_tokens: 8}}});
  if (mode === "no-result") return;
  const result = {event: "result", result: {conversation_id: exact, status: "SUCCESS", response: "Pong!", usage: {input_tokens: 1003}}};
  write(result);
  if (mode === "duplicate-result") write(result);
  if (mode === "nonzero") process.exitCode = 32;
});
`;

async function withFixture(
  mode: string,
  body: (options: Parameters<typeof runAgyTurn>[0], cwd: string) => Promise<void>,
) {
  const cwd = await mkdtemp(join(resolvePreferredOpenClawTmpDir(), "openclaw-agy-test-"));
  try {
    await body(
      {
        launch: {
          argv: [process.execPath, "-e", fixture, mode, expectedId, replacementId, model],
          cwd,
          env: {},
        },
        requestedModel: model,
        expectedConversationId: expectedId,
        signal: AbortSignal.timeout(10_000),
        assertCurrent() {},
        bindConversation() {},
        prompt,
      },
      cwd,
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

describe("Antigravity native turn", () => {
  it("checks init before stdin and reports streamed text and non-cumulative turn usage", async () => {
    await withFixture("valid", async (options, cwd) => {
      const partial: string[] = [];
      const result = await runAgyTurn({
        ...options,
        bindConversation: async (init) => {
          expect(init.conversationId).toBe(expectedId);
          expect(await readdir(cwd)).toEqual([]);
        },
        onDelta: (text) => {
          partial.push(text);
        },
      });
      expect(await readdir(cwd)).toEqual(["received"]);
      expect(partial).toEqual(["Pong", "!"]);
      expect(result).toEqual({
        conversationId: expectedId,
        acknowledgedModel: model,
        text: "Pong!",
        turnUsage: { input: 3, output: 1, cacheRead: 8 },
      });
    });
  });

  it.each([
    ["replacement", /exact conversation/],
    ["wrong-model", /requested model/],
  ])("never sends stdin on %s", async (mode, error) => {
    await withFixture(mode, async (options, cwd) => {
      await expect(runAgyTurn(options)).rejects.toThrow(error);
      expect(await readdir(cwd)).toEqual([]);
    });
  });

  it("does not send a prompt when host session admission is lost during binding", async () => {
    await withFixture("valid", async (options, cwd) => {
      let active = true;
      await expect(
        runAgyTurn({
          ...options,
          bindConversation: () => {
            active = false;
          },
          assertCurrent: () => {
            if (!active) {
              throw new Error("Stale host session");
            }
          },
        }),
      ).rejects.toThrow("Stale host session");
      expect(await readdir(cwd)).toEqual([]);
    });
  });

  it.each([
    ["no-result", /complete native result/],
    ["duplicate-result", /after the terminal result/],
    ["nonzero", /successfully/],
  ])("fails closed on %s", async (mode, error) => {
    await withFixture(mode, async (options) => {
      await expect(runAgyTurn(options)).rejects.toThrow(error);
    });
  });

  it("stops a silent native tool before it can produce a delayed effect", async () => {
    await withFixture("silent-tool", async (options, cwd) => {
      const stop = new AbortController();
      await expect(
        runAgyTurn({
          ...options,
          signal: AbortSignal.any([options.signal, stop.signal]),
          onDelta: () => stop.abort(new Error("Stop requested")),
        }),
      ).rejects.toThrow("Stop requested");
      expect(await readdir(cwd)).toEqual(["received"]);
    });
  });

  it("accepts a successful turn after the owner confirms forced relay retirement", async () => {
    const close = vi.mocked(closeOwnedStdioProcess);
    const actual = close.getMockImplementation()!;
    close.mockImplementationOnce(async (...args) => {
      await actual(...args);
      return {
        reason: "forced-relay-exit",
        signalRequested: "SIGKILL",
        exit: { code: null, signal: "SIGKILL" },
        durationMs: 5,
        escalationAfterMs: 1,
      };
    });
    await withFixture("valid", async (options) => {
      await expect(runAgyTurn(options)).resolves.toMatchObject({ text: "Pong!" });
    });
  });

  it("fails closed if the process owner cannot confirm descendant extinction", async () => {
    const close = vi.mocked(closeOwnedStdioProcess);
    const actual = close.getMockImplementation()!;
    const failure = new OwnedStdioCleanupError("Kernel descendant extinction is unconfirmed.");
    close.mockImplementationOnce(async (...args) => {
      await actual(...args);
      throw failure;
    });
    await withFixture("valid", async (options) => {
      await expect(runAgyTurn(options)).rejects.toBe(failure);
    });
  });
});

it("registers a fresh binding before stdin and resumes without rewriting it", async () => {
  await withFixture("valid", async (wire, cwd) => {
    const route = { backend: "account", profile: "profile-a", model } as const;
    let saved: AgySessionBinding | undefined;
    const store = {
      lookup: async () => saved,
      registerIfAbsent: vi.fn(async (_id: string, binding: AgySessionBinding) => {
        expect(await readdir(cwd)).toEqual([]);
        saved = binding;
        return true;
      }),
    };
    const preparePlacement = vi.fn(async () => ({
      launch: wire.launch,
      [Symbol.asyncDispose]: async () => {},
    }));
    const options = {
      ...wire,
      sessionId: "host-session",
      workspace: cwd,
      route,
      catalog: { ...route, models: [{ id: model, label: "Flash Low" }] },
      store,
      preparePlacement,
    };
    await expect(runBoundAgyTurn(options)).resolves.toMatchObject({ conversationId: expectedId });
    await expect(runBoundAgyTurn(options)).resolves.toMatchObject({ conversationId: expectedId });
    expect(preparePlacement.mock.calls).toEqual([[undefined], [expectedId]]);
    expect(store.registerIfAbsent).toHaveBeenCalledTimes(1);
  });
});

it("refuses mismatched backend, catalog profile, stale binding, and unlisted model before launch", async () => {
  await withFixture("valid", async (wire, cwd) => {
    const route = { backend: "account", profile: "profile-a", model } as const;
    const store = {
      lookup: vi.fn<() => Promise<AgySessionBinding | undefined>>(),
      registerIfAbsent: vi.fn(),
    };
    const preparePlacement = vi.fn(async () => ({
      launch: wire.launch,
      [Symbol.asyncDispose]: async () => {},
    }));
    const catalog = { ...route, models: [{ id: model, label: "Flash Low" }] };
    const opts = {
      ...wire,
      sessionId: "host-session",
      workspace: cwd,
      route,
      catalog,
      store,
      preparePlacement,
    };
    await expect(
      runBoundAgyTurn({ ...opts, catalog: { ...catalog, backend: "gemini-key" } }),
    ).rejects.toThrow(/catalog/);
    await expect(
      runBoundAgyTurn({ ...opts, catalog: { ...catalog, profile: "other" } }),
    ).rejects.toThrow(/catalog/);
    await expect(runBoundAgyTurn({ ...opts, catalog: { ...catalog, models: [] } })).rejects.toThrow(
      /catalog/,
    );
    store.lookup.mockResolvedValue({
      version: 1,
      route,
      workspace: join(cwd, "elsewhere"),
      conversationId: expectedId,
    });
    await expect(runBoundAgyTurn(opts)).rejects.toThrow(/workspace, profile, or model/);
    expect(preparePlacement).not.toHaveBeenCalled();
    expect(await readdir(cwd)).toEqual([]);
  });
});

it("does not submit input if an existing binding wins the create-once write", async () => {
  await withFixture("valid", async (wire, cwd) => {
    const route = { backend: "gemini-key", profile: "profile-k", model } as const;
    const opts = {
      ...wire,
      sessionId: "host-session",
      workspace: cwd,
      route,
      catalog: { ...route, models: [{ id: model, label: "Flash Low" }] },
      store: { lookup: async () => undefined, registerIfAbsent: async () => false },
      preparePlacement: async () => ({
        launch: wire.launch,
        [Symbol.asyncDispose]: async () => {},
      }),
    };
    await expect(runBoundAgyTurn(opts)).rejects.toThrow(/another operation/);
    expect(await readdir(cwd)).toEqual([]);
  });
});

it.each(["stale-before-launch", "settled-child"] as const)(
  "does not release the bound turn before placement settlement: %s",
  async (mode) => {
    await withFixture("valid", async (wire, cwd) => {
      const route = { backend: "gemini-key", profile: "profile-k", model } as const;
      let active = true;
      let finishCleanup!: () => void;
      let enterCleanup!: () => void;
      const pendingCleanup = new Promise<void>((resolve) => {
        finishCleanup = resolve;
      });
      const cleanupEntered = new Promise<void>((resolve) => {
        enterCleanup = resolve;
      });
      const cleanup = vi.fn(async () => {
        enterCleanup();
        await pendingCleanup;
      });
      const attempt = runBoundAgyTurn({
        ...wire,
        sessionId: "host-session",
        workspace: cwd,
        route,
        catalog: { ...route, models: [{ id: model, label: "Flash Low" }] },
        store: { lookup: async () => undefined, registerIfAbsent: async () => true },
        preparePlacement: async () => {
          if (mode === "stale-before-launch") {
            active = false;
          }
          return { launch: wire.launch, [Symbol.asyncDispose]: cleanup };
        },
        assertCurrent() {
          if (!active) {
            throw new Error("Synthetic stale admission");
          }
        },
      });
      let resultObserved = false;
      const outcome = attempt.then(
        (result) => {
          resultObserved = true;
          return result;
        },
        (error: unknown) => {
          resultObserved = true;
          return error;
        },
      );
      try {
        await cleanupEntered;
        expect(resultObserved).toBe(false);
        expect(await readdir(cwd)).toEqual(mode === "settled-child" ? ["received"] : []);
      } finally {
        finishCleanup();
      }
      expect(await outcome).toMatchObject(
        mode === "settled-child" ? { text: "Pong!" } : { message: "Synthetic stale admission" },
      );
      expect(cleanup).toHaveBeenCalledOnce();
    });
  },
);
