// Proves the native Claude login owner is the account Anthropic attests for the credential.
import fs from "node:fs";
import path from "node:path";
import { deserialize } from "node:v8";
import { Worker } from "node:worker_threads";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockClaudeManagedSettings } from "../../../test/helpers/claude-managed-settings.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { runWithCliHistoryWriter } from "../../config/sessions/cli-history-boundary.js";
import {
  appendSessionTranscriptReport,
  loadSessionEntryReadOnly,
  patchSessionEntryCore,
  persistSessionTranscriptTurn,
} from "../../config/sessions/session-accessor.js";
import { resolveStateDir } from "../../config/state-dir.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { useSessionStoreTempDirs } from "../../test-utils/session-state-cleanup.js";
import * as cliCredentials from "../cli-credentials.js";
import { SessionManager } from "../sessions/session-manager.js";
import { persistCliAssistantTranscript } from "./cli-run-transcript.js";
import { prepareCliHistoryBoundary } from "./history-boundary.js";
import { createHistoryBoundaryFixture, history } from "./history-boundary.test-support.js";
import type { PreparedCliRunContext } from "./types.js";

const sessionDirs = useSessionStoreTempDirs(afterAll, "cli-history-boundary-native-");
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const fixture = (withHeader?: boolean) => createHistoryBoundaryFixture(sessionDirs, withHeader);
type Fixture = Awaited<ReturnType<typeof fixture>>;
const authorityChanged = "CLI history authority changed";
const append = (f: Fixture, content: string, timestamp = 2) =>
  f.manager().appendMessage({ role: "user", content, timestamp });
const expectCoverage = (f: Fixture, maxSeq: number) =>
  expect(loadSessionEntryReadOnly(f.target)?.cliHistoryBoundary).toMatchObject({
    state: "known",
    maxSeq,
  });

describe("native CLI login owner", () => {
  // The operator's opt-in to sending the native token to Anthropic's profile endpoint.
  const attestNativeLogin: OpenClawConfig = {
    plugins: {
      entries: { anthropic: { config: { historyRecovery: { attestNativeLogin: true } } } },
    },
  };
  const native = { provider: "claude-cli", config: attestNativeLogin };
  // Stub Anthropic profile endpoint: a synthetic token names its own account.
  const profile = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const bearer = new Headers(init?.headers).get("authorization") ?? "";
    const match = /^Bearer synthetic-token-for-(.+?)(?:-rotated-\d+)?$/u.exec(bearer);
    return match
      ? Response.json({ account: { uuid: match[1] }, organization: { uuid: "org" } })
      : new Response("{}", { status: 401 });
  });
  beforeEach(() => {
    mockClaudeManagedSettings(sessionDirs.make());
    profile.mockClear();
    vi.stubGlobal("fetch", profile);
  });
  let rotation = 0;
  const credentialFor = (accountUuid: string, options: { rotate?: boolean; expiresAt?: number }) =>
    JSON.stringify({
      claudeAiOauth: {
        accessToken: `synthetic-token-for-${accountUuid}${options.rotate ? `-rotated-${++rotation}` : ""}`,
        expiresAt: options.expiresAt ?? Date.parse("2030-01-01T00:00:00Z"),
      },
    });
  // Synthetic logins on disk, selected the way the child Claude selects them: by its config dir.
  // The account record and the credential agree unless `recordAccount` says otherwise.
  const loginIn = (
    dir: string,
    accountUuid: string | undefined,
    options: { recordAccount?: string; rotate?: boolean; expiresAt?: number } = {},
  ) => {
    fs.mkdirSync(dir, { recursive: true });
    if (accountUuid === undefined) {
      fs.rmSync(path.join(dir, ".credentials.json"), { force: true });
      return;
    }
    fs.writeFileSync(
      path.join(dir, ".claude.json"),
      JSON.stringify({ oauthAccount: { accountUuid: options.recordAccount ?? accountUuid } }),
    );
    fs.writeFileSync(path.join(dir, ".credentials.json"), credentialFor(accountUuid, options));
  };
  const backendUsing = (configDir: string | undefined, env: Record<string, string> = {}) => ({
    backend: {
      command: "claude",
      env: { ...(configDir ? { CLAUDE_CONFIG_DIR: configDir } : {}), ...env },
    },
  });
  const logins = () => {
    const gateway = sessionDirs.make();
    const backend = sessionDirs.make();
    loginIn(gateway, "uuid:gateway-account");
    // The Gateway process has its own login; only the child environment may decide ownership.
    vi.stubEnv("CLAUDE_CONFIG_DIR", gateway);
    return { gateway, backend };
  };
  const seedNative = async (f: Fixture, prepared: ReturnType<typeof backendUsing>) => {
    await f.run(
      undefined,
      async (allowed) => {
        expect(allowed).toBe(true);
        append(f, "native canary", 1);
      },
      native,
      undefined,
      prepared,
    );
  };
  const setupNative = async (seed = false, account = "uuid:account-a") => {
    const f = await fixture();
    const { gateway, backend } = logins();
    loginIn(backend, account);
    const prepared = backendUsing(backend);
    if (seed) {
      await seedNative(f, prepared);
    }
    return { f, gateway, backend, prepared };
  };
  const coveredSeq = (f: Fixture) =>
    (loadSessionEntryReadOnly(f.target)?.cliHistoryBoundary as { maxSeq: number } | undefined)
      ?.maxSeq ?? -1;
  const prepareWith = async (f: Fixture, prepared: ReturnType<typeof backendUsing> | undefined) => {
    return f.run(
      undefined,
      async (allowed, params) => ({
        allowed,
        seeded: await history(allowed, params),
      }),
      native,
      undefined,
      prepared,
    );
  };
  /** Prepares a native writer on its own run id so assertions can be driven directly. */
  const withWriter = async (
    f: Fixture,
    runId: string,
    prepared: ReturnType<typeof backendUsing>,
    action: (
      writer: NonNullable<Awaited<ReturnType<typeof prepareCliHistoryBoundary>>>,
      params: PreparedCliRunContext["params"],
    ) => void | Promise<void>,
  ) => {
    await patchSessionEntryCore(f.target, (entry) => ({ ...entry, activeWriterRunId: runId }));
    await f.withRun(
      runId,
      async (params) => {
        const writer = await prepareCliHistoryBoundary(params, { preparedBackend: prepared });
        if (!writer) {
          throw new Error("Missing admitted history writer");
        }
        await runWithCliHistoryWriter(writer, async () => await action(writer, params));
      },
      native,
    );
  };

  it("resolves ownership from the backend-selected config dir, not the Gateway login", async () => {
    const { f, backend } = await setupNative(true, "uuid:backend-account");
    // Same backend selection keeps the owner.
    const same = await prepareWith(f, backendUsing(backend));
    expect(same.allowed).toBe(true);
    expect(same.seeded).toContain("native canary");
    // Dropping the override runs the child under the Gateway login: another account.
    const gatewayChild = await prepareWith(f, backendUsing(undefined));
    expect(gatewayChild.allowed).toBe(false);
    expect(gatewayChild.seeded).toBeUndefined();
  });

  it("resolves the owner under the run's skill env overrides, as execution does", async () => {
    const f = await fixture();
    const skill = sessionDirs.make();
    loginIn(skill, "uuid:skill-account");
    // The Gateway process has no login of its own; only the skill env selects one. Keep the
    // state dir where the fixture created it.
    vi.stubEnv("OPENCLAW_STATE_DIR", resolveStateDir(process.env));
    vi.stubEnv("HOME", sessionDirs.make());
    vi.stubEnv("CLAUDE_CONFIG_DIR", undefined);
    // Skill env overrides read the live runtime config, as execution does. The fixture resets it.
    const config = {
      ...attestNativeLogin,
      skills: { entries: { "login-skill": { env: { CLAUDE_CONFIG_DIR: skill } } } },
    } as OpenClawConfig;
    setRuntimeConfigSnapshot(config, config);
    const withSkill = {
      ...native,
      skillsSnapshot: { prompt: "", skills: [{ name: "login-skill" }] },
      config,
    };
    const prepared = backendUsing(undefined);
    await f.run(
      undefined,
      async (allowed) => {
        expect(allowed).toBe(true);
        append(f, "skill canary", 1);
      },
      withSkill,
      undefined,
      prepared,
    );
    expect(process.env.CLAUDE_CONFIG_DIR).toBeUndefined();
    await f.run(
      undefined,
      async (allowed, params) => {
        expect(allowed).toBe(true);
        expect(await history(allowed, params)).toContain("skill canary");
      },
      withSkill,
      undefined,
      prepared,
    );
    await f.run(
      undefined,
      async (allowed) => expect(allowed).toBe(false),
      native,
      undefined,
      prepared,
    );
  });

  it.each(["API key", "unprepared backend", "forwarded credential", "node placement"])(
    "has no native owner with %s",
    async (mode) => {
      const { f, backend } = await setupNative();
      const lookup = vi.spyOn(cliCredentials, "resolveNativeCliLoginOwner");
      const prepared =
        mode === "unprepared backend"
          ? undefined
          : backendUsing(backend, mode === "API key" ? { ANTHROPIC_API_KEY: "synthetic-key" } : {});
      const credential =
        mode === "forwarded credential"
          ? {
              type: "oauth" as const,
              provider: "claude-cli",
              access: "synthetic-access",
              refresh: "synthetic-refresh",
              expires: Date.now() + 60_000,
            }
          : undefined;
      await f.run(
        undefined,
        async (allowed) => expect(allowed).toBe(false),
        mode === "node placement"
          ? { ...native, sessionEntry: { execHost: "node", execNode: "node-a" } as never }
          : native,
        credential,
        prepared,
      );
      if (mode !== "API key") {
        expect(lookup).not.toHaveBeenCalled();
      }
      expect(profile).not.toHaveBeenCalled();
    },
  );

  it("rejects a recovery boundary for a reassigned or revoked login, uncached, at the same instant", async () => {
    const { f, backend } = await setupNative();
    // A frozen clock: any time-windowed reuse would still be inside its window.
    vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    await withWriter(f, "boundary-native-fresh", backendUsing(backend), (writer) => {
      writer.checkNativeLoginBoundary(true);
      loginIn(backend, "uuid:account-b");
      expect(() => writer.checkNativeLoginBoundary(true)).toThrow(authorityChanged);
      loginIn(backend, undefined);
      expect(() => writer.checkNativeLoginBoundary(true)).toThrow(authorityChanged);
      loginIn(backend, "uuid:account-a");
      writer.checkNativeLoginBoundary(true);
      loginIn(backend, "uuid:account-b");
      loginIn(backend, "uuid:account-a");
      writer.checkNativeLoginBoundary(true);
      // The same account's rotated token is refused until it is attested.
      loginIn(backend, "uuid:account-a", { rotate: true });
      expect(() => writer.checkNativeLoginBoundary(true)).toThrow(authorityChanged);
    });
  });

  it("refuses private input at the readable boundary once the login is reassigned", async () => {
    const { f, backend } = await setupNative(true);
    await withWriter(f, "boundary-native-readable", backendUsing(backend), async (writer) => {
      profile.mockClear();
      await writer.assertReadable();
      loginIn(backend, "uuid:account-b");
      await expect(writer.assertReadable()).rejects.toThrow(authorityChanged);
      expect(profile).not.toHaveBeenCalled();
    });
  });

  it("binds execution to the login the spawned environment selects", async () => {
    const { f, gateway, backend } = await setupNative();
    await withWriter(f, "boundary-native-bind", backendUsing(backend), (writer) => {
      writer.bindExecutionEnv({ CLAUDE_CONFIG_DIR: backend }, true);
      writer.checkNativeLoginBoundary(true);
      // A recovery turn drifting to another config dir is refused before anything is spawned.
      expect(() => writer.bindExecutionEnv({ CLAUDE_CONFIG_DIR: gateway }, true)).toThrow(
        authorityChanged,
      );
      expect(() => writer.checkNativeLoginBoundary(true)).toThrow(authorityChanged);
      writer.bindExecutionEnv({ CLAUDE_CONFIG_DIR: backend }, true);
      writer.checkNativeLoginBoundary(true);
      expect(writer.confirmsOwner?.()).toBe(true);
    });
  });

  it("runs a turn without saved history under another login but never covers it", async () => {
    const { f, gateway, backend } = await setupNative(true);
    const before = coveredSeq(f);
    await withWriter(f, "boundary-native-late-env", backendUsing(backend), (writer) => {
      // A late override (for example a skill env) selects another login: no refusal.
      writer.bindExecutionEnv({ CLAUDE_CONFIG_DIR: gateway }, false);
      writer.checkNativeLoginBoundary(false);
      // Detachment is sticky even if the environment returns to the prepared login.
      writer.bindExecutionEnv({ CLAUDE_CONFIG_DIR: backend }, false);
      expect(writer.confirmsOwner?.()).toBe(false);
      append(f, "late login turn", 2);
      expectCoverage(f, before);
    });
    expect(JSON.stringify(f.manager().getEntries())).toContain("late login turn");
  });

  it("keeps a reply but stops coverage once the login can no longer be established", async () => {
    const { f, backend } = await setupNative(true);
    const before = coveredSeq(f);
    const real = cliCredentials.readAttestedNativeCliLoginOwner;
    let unknown = false;
    // An unresolvable login (for example both Keychain lookups failing) resolves to no owner.
    vi.spyOn(cliCredentials, "readAttestedNativeCliLoginOwner").mockImplementation((id, env) =>
      unknown ? undefined : real(id, env),
    );
    await withWriter(
      f,
      "boundary-native-unknown",
      backendUsing(backend),
      async (writer, params) => {
        writer.checkNativeLoginBoundary(true);
        unknown = true;
        expect(() => writer.checkNativeLoginBoundary(true)).toThrow(authorityChanged);
        const result = await persistCliAssistantTranscript({
          runParams: { ...params, persistAssistantTranscript: true },
          text: "reply produced while the login was unknown",
          modelId: "test-model",
          stopReason: "stop",
        });
        expect(result.terminalAnchor).toBeDefined();
      },
    );
    expect(JSON.stringify(f.manager().getEntries())).toContain(
      "reply produced while the login was unknown",
    );
    expectCoverage(f, before);
  });

  it("records a turn whose login changed after preparation without covering it", async () => {
    const { f, backend } = await setupNative(true);
    const before = coveredSeq(f);
    await withWriter(f, "boundary-native-coverage", backendUsing(backend), () => {
      loginIn(backend, "uuid:account-b");
      append(f, "turn under account b", 2);
      expectCoverage(f, before);
      // Coverage is contiguous: once a row is skipped, a later row cannot be covered either.
      loginIn(backend, "uuid:account-a");
      append(f, "turn under account a", 3);
      expect(loadSessionEntryReadOnly(f.target)?.cliHistoryBoundary).toMatchObject({
        maxSeq: before,
      });
    });
    expect(JSON.stringify(f.manager().getEntries())).toContain("turn under account b");
    const next = await prepareWith(f, backendUsing(backend));
    expect(next.allowed).toBe(false);
    expect(next.seeded).toBeUndefined();
  });

  it("owns history by the attested credential, never by the account record beside it", async () => {
    const { f, backend } = await setupNative(true);
    // A credential for account B beside an unchanged record for account A belongs to B.
    loginIn(backend, "uuid:account-b", { recordAccount: "uuid:account-a" });
    const mismatched = await prepareWith(f, backendUsing(backend));
    expect(mismatched.allowed).toBe(false);
    expect(mismatched.seeded).toBeUndefined();
    // A record naming B beside account A's credential does not move A's history away.
    const g = await fixture();
    loginIn(backend, "uuid:account-a");
    await seedNative(g, backendUsing(backend));
    loginIn(backend, "uuid:account-a", { recordAccount: "uuid:account-b" });
    const relabelled = await prepareWith(g, backendUsing(backend));
    expect(relabelled.allowed).toBe(true);
    expect(relabelled.seeded).toContain("native canary");
  });

  it("attests a token the CLI rotated mid-run before covering the run's rows", async () => {
    const { f, backend } = await setupNative(true);
    const before = coveredSeq(f);
    await withWriter(f, "boundary-native-rotated", backendUsing(backend), async (writer) => {
      writer.bindExecutionEnv({ CLAUDE_CONFIG_DIR: backend }, false);
      loginIn(backend, "uuid:account-a", { rotate: true });
      writer.checkNativeLoginBoundary(false);
      // Coverage waits for the background attestation.
      expect(writer.confirmsOwner?.()).toBe(false);
      await writer.settleNativeLogin();
      expect(writer.confirmsOwner?.()).toBe(true);
      append(f, "rotated turn", 2);
      expectCoverage(f, before + 1);
    });
    const next = await prepareWith(f, backendUsing(backend));
    expect(next.allowed).toBe(true);
    expect(next.seeded).toContain("rotated turn");
  });

  it("stops coverage when a mid-run token attests to another account", async () => {
    const { f, backend } = await setupNative(true);
    await withWriter(f, "boundary-native-rotated-away", backendUsing(backend), async (writer) => {
      writer.bindExecutionEnv({ CLAUDE_CONFIG_DIR: backend }, false);
      loginIn(backend, "uuid:account-b", { rotate: true, recordAccount: "uuid:account-a" });
      writer.checkNativeLoginBoundary(false);
      // The prepared login is back before the attestation settles: coverage still waits.
      loginIn(backend, "uuid:account-a");
      expect(writer.confirmsOwner?.()).toBe(false);
      await writer.settleNativeLogin();
      // Detachment is sticky once the foreign token is attested.
      expect(writer.confirmsOwner?.()).toBe(false);
    });
  });

  // Runs `flip` right after the host hands the SQLite worker a command of this type, so the
  // login changes while that command is queued and before its transaction asks the host.
  const afterCommandQueued = (type: string, flip: () => void) => {
    const post = Reflect.get(Worker.prototype, "postMessage") as Worker["postMessage"];
    const state = { flipped: false };
    vi.spyOn(Worker.prototype, "postMessage").mockImplementation(function (
      this: Worker,
      ...args: Parameters<Worker["postMessage"]>
    ) {
      const request = args[0] as { type?: string; input?: unknown } | undefined;
      // Read the command before posting: the host transfers its buffer to the worker.
      const command =
        !state.flipped && request?.type === "execute" && request.input instanceof Uint8Array
          ? (deserialize(request.input) as {
              type?: string;
              input?: { command?: { type?: string } };
            })
          : undefined;
      post.apply(this, args);
      // Domain workers wrap the report command; the turn worker takes it directly.
      if (command && (command.input?.command ?? command).type === type) {
        state.flipped = true;
        flip();
      }
    });
    return state;
  };

  it("does not cover a turn commit whose login is reassigned while the command is queued", async () => {
    const { f, backend } = await setupNative(true);
    let covered = coveredSeq(f);
    await withWriter(f, "boundary-native-queued-turn", backendUsing(backend), async () => {
      profile.mockClear();
      await persistSessionTranscriptTurn(f.target, {
        expectedSessionId: f.target.sessionId,
        messages: [1, 2, 3].map((n) => ({
          message: { role: "user" as const, content: `covered row ${n}`, timestamp: 1 + n },
        })),
      });
      expect(coveredSeq(f)).toBe(covered + 3);
      covered += 3;
      expect(profile).not.toHaveBeenCalled();
      const queued = afterCommandQueued("session.turn.commit", () =>
        loginIn(backend, "uuid:account-b", { rotate: true, recordAccount: "uuid:account-a" }),
      );
      await persistSessionTranscriptTurn(f.target, {
        expectedSessionId: f.target.sessionId,
        messages: [{ message: { role: "user", content: "queued under account b", timestamp: 2 } }],
      });
      expect(queued.flipped).toBe(true);
    });
    expect(JSON.stringify(f.manager().getEntries())).toContain("queued under account b");
    expect(loadSessionEntryReadOnly(f.target)?.cliHistoryBoundary).toMatchObject({
      maxSeq: covered,
    });
  });

  it("does not cover a transcript report whose login is reassigned while the command is queued", async () => {
    const { f, backend } = await setupNative(true);
    const report = async (content: string) =>
      await appendSessionTranscriptReport(f.target, {
        kind: "custom",
        customTypes: ["status"],
        selectReport: () => ({ customType: "status", content, display: true }),
      });
    await withWriter(f, "boundary-native-queued-report", backendUsing(backend), async () => {
      const start = coveredSeq(f);
      // Positive control: the owner holds as the write is sent.
      await expect(report("report under account a")).resolves.toMatchObject({ ok: true });
      expect(coveredSeq(f)).toBe(start + 1);
      const queued = afterCommandQueued("append", () =>
        loginIn(backend, "uuid:account-b", { rotate: true, recordAccount: "uuid:account-a" }),
      );
      await expect(report("queued report b")).resolves.toMatchObject({ ok: true });
      expect(queued.flipped).toBe(true);
      expect(coveredSeq(f)).toBe(start + 1);
    });
    expect(JSON.stringify(f.manager().getEntries())).toContain("queued report b");
  });

  it("runs a refresh-due turn without saved history but keeps covering it", async () => {
    const { f, backend } = await setupNative(true);
    const before = coveredSeq(f);
    // Valid, but inside the window where Claude CLI rotates it before accepting a prompt.
    loginIn(backend, "uuid:account-a", { rotate: true, expiresAt: Date.now() + 60_000 });
    await withWriter(f, "boundary-native-refresh-due", backendUsing(backend), async (writer) => {
      expect(writer.replaysHistory).toBe(false);
      append(f, "refresh-due ask", 2);
      writer.bindExecutionEnv({ CLAUDE_CONFIG_DIR: backend }, false);
      // The CLI rotates after the last boundary check; settling attests what it left.
      loginIn(backend, "uuid:account-a", { rotate: true });
      await writer.settleNativeLogin();
      f.manager().appendMessage({ role: "assistant", content: "reply", timestamp: 3 } as never);
      expectCoverage(f, before + 2);
    });
    const next = await prepareWith(f, backendUsing(backend));
    expect(next.allowed).toBe(true);
    expect(next.seeded).toContain("refresh-due ask");
  });

  it("covers a SessionManager append only while the native login owner holds", async () => {
    const { f, backend } = await setupNative();
    await withWriter(f, "boundary-native-metadata", backendUsing(backend), async () => {
      const manager = await SessionManager.openAsync(f.target);
      const before = coveredSeq(f);
      await manager.appendMessageAsync({ role: "user", content: "under a", timestamp: 1 });
      const covered = coveredSeq(f);
      expect(covered).toBeGreaterThan(before);
      // Another account's credential, never attested by this process.
      loginIn(backend, "uuid:account-b");
      await manager.appendMessageAsync({ role: "user", content: "under b", timestamp: 2 });
      expect(coveredSeq(f)).toBe(covered);
      expect(JSON.stringify(manager.getEntries())).toContain("under b");
    });
  });

  it("treats a login lookup that throws as no owner at every check", async () => {
    const { f, backend } = await setupNative();
    await withWriter(f, "boundary-native-enotdir", backendUsing(backend), async (writer) => {
      const manager = await SessionManager.openAsync(f.target);
      const before = coveredSeq(f);
      // A config root replaced by a file makes the credential lookup throw (ENOTDIR).
      fs.rmSync(backend, { recursive: true });
      fs.writeFileSync(backend, "");
      await manager.appendMessageAsync({ role: "user", content: "unreadable", timestamp: 1 });
      expect(coveredSeq(f)).toBe(before);
      expect(JSON.stringify(manager.getEntries())).toContain("unreadable");
      // Saved history is refused; a turn without it runs on, uncovered.
      expect(() => writer.checkNativeLoginBoundary(true)).toThrow(authorityChanged);
      writer.checkNativeLoginBoundary(false);
    });
  });
});
