import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveCommandAuthorization } from "../auto-reply/command-auth.js";
import { bindCommandOwnerAuthority } from "../auto-reply/command-owner-authority.js";
import { buildCommandContext } from "../auto-reply/reply/commands-context.js";
import { handleInlineActions } from "../auto-reply/reply/get-reply-inline-actions.js";
import {
  createHandleInlineActionsInput,
  createTypingController,
} from "../auto-reply/reply/get-reply-inline-actions.test-support.js";
import { prepareInternalGetReplyOptions } from "../auto-reply/reply/get-reply.types.js";
import { resolveElevatedPermissions } from "../auto-reply/reply/reply-elevated.js";
import { buildTestCtx } from "../auto-reply/reply/test-ctx.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveChatSendCallerContext } from "../gateway/server-methods/gateway-client-identity.js";
import { sharingPolicyClient } from "../gateway/session-sharing.test-utils.js";
import { saveExecApprovals } from "../infra/exec-approvals-store.test-support.js";
import { loadExecApprovalsReadOnly } from "../infra/exec-approvals.js";
import type { ExecAutoReviewer } from "../infra/exec-auto-review.js";
import { resolveExecutablePath } from "../infra/executable-path.js";
import { createProcessSupervisor } from "../process/supervisor/supervisor.js";
import type { ProcessSupervisor } from "../process/supervisor/types.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { createAdmittedRunOperatorAuthority } from "./admitted-run-context.js";
import { getFinishedSession, getSession, waitForExecSession } from "./bash-process-registry.js";
import { resetProcessRegistryForTests } from "./bash-process-registry.test-support.js";
import { createExecTool, createExecToolForReply } from "./bash-tools.exec-run.js";
import type { ExecElevatedDefaults } from "./bash-tools.exec-types.js";
import { withGatewayToolCallerIdentity } from "./tools/gateway-caller-context.js";

// Execution spy arguments contain inherited environment; assert only scalar projections.
const boundary = vi.hoisted(() => ({
  spawn: vi.fn<ProcessSupervisor["spawn"]>(),
  prepare: vi.fn<() => Promise<void>>(),
}));
const transport = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock("../process/supervisor/index.js", () => ({
  getProcessSupervisor: () => ({ spawn: boundary.spawn }),
}));
// Only the network transport is replaced; real tool/gateway identity and approval routing run.
vi.mock("../gateway/call.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../gateway/call.js")>();
  return { ...actual, callGateway: transport.call };
});
vi.mock("./shell-snapshot.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./shell-snapshot.js")>();
  return {
    ...actual,
    maybeWrapCommandWithShellSnapshot: async (
      ...args: Parameters<typeof actual.maybeWrapCommandWithShellSnapshot>
    ) => {
      await boundary.prepare();
      return actual.maybeWrapCommandWithShellSnapshot(...args);
    },
  };
});

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const python3 = resolveExecutablePath("python3", { useCache: false });

describe.skipIf(process.platform === "win32")("gateway execution authorization boundary", () => {
  let root: string;
  let supervisor: ReturnType<typeof createProcessSupervisor> | undefined;
  beforeEach(() => {
    root = fs.realpathSync(tempDirs.make("exec-authorization-boundary-"));
    for (const key of ["HOME", "USERPROFILE", "OPENCLAW_HOME", "ZDOTDIR"]) {
      vi.stubEnv(key, root);
    }
    vi.stubEnv("OPENCLAW_STATE_DIR", path.join(root, "state"));
    vi.stubEnv("PATH", "/usr/bin:/bin");
    vi.stubEnv("SHELL", "/bin/bash");
    vi.stubEnv("OPENCLAW_EXEC_SHELL_SNAPSHOT", "1");
    setRuntimeConfigSnapshot({});
    saveExecApprovals({
      version: 1,
      defaults: { security: "allowlist", ask: "on-miss", askFallback: "deny" },
      agents: {},
    });
    resetProcessRegistryForTests();
    boundary.prepare.mockReset().mockResolvedValue(undefined);
    const liveSupervisor = createProcessSupervisor();
    supervisor = liveSupervisor;
    boundary.spawn.mockReset().mockImplementation((input) => liveSupervisor.spawn(input));
    transport.call.mockReset();
  });
  afterEach(async () => {
    await supervisor?.shutdown();
    supervisor = undefined;
    resetProcessRegistryForTests();
    closeOpenClawStateDatabaseForTest();
    vi.unstubAllEnvs();
  });
  function tool(
    autoReviewer: ExecAutoReviewer,
    mode: "auto" | "ask" | "allowlist" | "full" = "auto",
    pathPrepend?: string[],
  ) {
    return createExecTool({
      agentId: "main",
      host: "gateway",
      mode,
      pathPrepend,
      safeBins: [],
      autoReviewer,
      cwd: root,
      runId: "boundary-probe-run",
      messageProvider: "webchat",
      nonInteractiveApproval: mode === "auto",
      notifyOnExit: false,
    });
  }
  function reviewer() {
    return vi.fn<ExecAutoReviewer>(async () => ({
      decision: "allow-once",
      risk: "low",
      rationale: "list fixture files",
    }));
  }

  function setPolicy(security: "allowlist" | "deny", allowlisted = false) {
    saveExecApprovals({
      version: 1,
      defaults: { security, ask: security === "deny" ? "off" : "on-miss", askFallback: "deny" },
      agents: allowlisted ? { main: { allowlist: [{ pattern: "/bin/ls" }] } } : {},
    });
  }

  const elevatedDefaults: ExecElevatedDefaults = {
    enabled: true,
    allowed: true,
    defaultLevel: "on",
  };

  function callerAuthority(signal?: AbortSignal) {
    return createAdmittedRunOperatorAuthority({
      profileId: "profile-ada",
      scopes: ["operator.write"],
      signal,
      assertCurrent() {},
    });
  }

  function chatBashInput(params: {
    body?: string;
    ctx?: ReturnType<typeof buildTestCtx>;
    cfg?: OpenClawConfig;
    operatorAuthority?: ReturnType<typeof callerAuthority>;
    abortSignal?: AbortSignal;
    opts?: ReturnType<typeof prepareInternalGetReplyOptions>;
    command?: Partial<ReturnType<typeof buildCommandContext>>;
    bashForegroundMs?: number;
  }) {
    const body = params.body ?? `! /bin/ls ${path.join(root, "approved.txt")}`;
    const cfg = params.cfg ?? {
      commands: {
        bash: true,
        text: true,
        ...(params.bashForegroundMs === undefined
          ? {}
          : { bashForegroundMs: params.bashForegroundMs }),
      },
    };
    const ctx =
      params.ctx ??
      buildTestCtx({
        Body: body,
        CommandBody: body,
        CommandAuthorized: true,
        ChatType: "direct",
      });
    const command = buildCommandContext(
      { ctx, cfg, agentId: "main", isGroup: false, triggerBodyNormalized: body },
      { ownerList: [], senderIsOwner: true, isAuthorizedSender: true },
    );
    const opts =
      params.opts ??
      (params.operatorAuthority || params.abortSignal
        ? {
            ...(params.operatorAuthority ? { operatorAuthority: params.operatorAuthority } : {}),
            ...(params.abortSignal ? { abortSignal: params.abortSignal } : {}),
          }
        : undefined);
    return createHandleInlineActionsInput({
      ctx,
      command: { ...command, ...params.command },
      typing: createTypingController(),
      cleanedBody: body,
      overrides: {
        cfg,
        isGroup: false,
        sessionKey: "agent:main:main",
        allowTextCommands: true,
        elevatedEnabled: true,
        elevatedAllowed: true,
        ...(opts ? { opts } : {}),
      },
    });
  }

  function chatBashReplyText(result: Awaited<ReturnType<typeof handleInlineActions>>) {
    if (result.kind !== "reply" || !result.reply || Array.isArray(result.reply)) {
      throw new Error("Expected a bash command reply");
    }
    return result.reply.text ?? "";
  }

  function verifiedChatSendInput(body: string) {
    const client = sharingPolicyClient({
      user: "profile-ada",
      scopes: ["operator.read", "operator.write"],
    });
    return buildTestCtx({
      ...resolveChatSendCallerContext(client),
      AgentId: "main",
      SessionKey: "agent:main:main",
      Body: body,
      BodyForAgent: body,
      BodyForCommands: body,
      RawBody: body,
      CommandBody: body,
      CommandAuthorized: true,
    });
  }

  function gatewayMethods() {
    return transport.call.mock.calls.map(([options]) => options.method);
  }

  function approve(decision: "allow-once" | "allow-always", beforeDecision?: () => void) {
    transport.call.mockImplementation(async (options: { method?: string; params?: unknown }) => {
      if (options.method === "exec.approval.request") {
        const id = (options.params as { id?: string } | undefined)?.id;
        return { status: "accepted", id };
      }
      if (options.method === "exec.approval.waitDecision") {
        beforeDecision?.();
        return { decision };
      }
      throw new Error(`Unexpected gateway call: ${options.method}`);
    });
  }

  it("gates encoded arithmetic before spawning while literal builtins still run", async () => {
    saveExecApprovals({
      version: 1,
      defaults: { security: "allowlist", ask: "off", askFallback: "deny" },
      agents: {},
    });
    const exec = tool(reviewer(), "allowlist");
    const control = await exec.execute("literal-builtin", { command: ": benign; pwd" });
    expect(control.details.status).toBe("completed");
    expect(control.details).toMatchObject({ exitCode: 0, aggregated: root });
    expect(boundary.spawn.mock.calls.length).toBe(1);
    boundary.spawn.mockClear();
    const marker = path.join(root, "arithmetic-marker");
    for (const command of [
      String.raw`: "$[ x[$'\x24\x28touch ${marker};printf 0\x29'] ]"`,
      String.raw`: "$(( x[$'\044\050touch ${marker};printf 0\051'] ))"`,
    ]) {
      await expect(exec.execute("arithmetic-builtin", { command })).rejects.toThrow(
        /allowlist|approval/i,
      );
      expect(boundary.spawn.mock.calls.length).toBe(0);
      expect(fs.existsSync(marker)).toBe(false);
    }
  });

  it("executes static assignments and blocks recursive assignments before process creation", async () => {
    const echoPath = fs.realpathSync("/bin/echo");
    saveExecApprovals({
      version: 1,
      defaults: { security: "allowlist", ask: "on-miss", askFallback: "deny" },
      agents: { main: { allowlist: [{ pattern: echoPath }] } },
    });
    const review = reviewer();

    const allowed = await tool(review, "allowlist").execute("static-assignment", {
      command: `STATIC=value; ${echoPath} static-ok`,
    });
    if (allowed.details.status !== "completed") {
      throw new Error(`Unexpected exec status: ${allowed.details.status}`);
    }
    expect(allowed.details.exitCode).toBe(0);
    expect(allowed.details.aggregated).toBe("static-ok");
    expect(boundary.spawn).toHaveBeenCalledOnce();
    expect(review).not.toHaveBeenCalled();
    expect(callGatewayTool).not.toHaveBeenCalled();

    const expectBlocked = async (id: string, command: string, marker: string) => {
      boundary.spawn.mockClear();
      const denied = await tool(review, "ask").execute(id, { command });
      expect(denied.details.status).toBe("failed");
      expect(boundary.spawn).not.toHaveBeenCalled();
      expect(fs.existsSync(marker)).toBe(false);
      expect(review).not.toHaveBeenCalled();
      expect(callGatewayTool).not.toHaveBeenCalled();
    };
    const scalarMarker = path.join(root, "recursive-scalar-assignment-ran");
    await expectBlocked(
      "recursive-scalar-assignment",
      `y='a[$(touch ${JSON.stringify(scalarMarker)})]'; x=$((y)); ${echoPath} unsafe`,
      scalarMarker,
    );
    const compoundMarker = path.join(root, "recursive-compound-assignment-ran");
    await expectBlocked(
      "recursive-compound-assignment",
      `y='a[$(touch ${JSON.stringify(compoundMarker)})]'; x=([y]=1); ${echoPath} unsafe`,
      compoundMarker,
    );
    const compoundAppendMarker = path.join(root, "recursive-compound-append-ran");
    await expectBlocked(
      "recursive-compound-append-assignment",
      `y='a[$(touch ${JSON.stringify(compoundAppendMarker)})]'; x=([y]+=1); ${echoPath} unsafe`,
      compoundAppendMarker,
    );
  });

  for (const shell of ["/bin/bash", "/bin/zsh"]) {
    it.skipIf(!fs.existsSync(shell))(
      `executes bound globs and chains without startup substitutions in ${shell}`,
      async () => {
        const command = "env -- env ls ~/approved.txt | cat && ls *.txt";
        vi.stubEnv("SHELL", shell);
        fs.writeFileSync(path.join(root, "approved.txt"), "fixture");
        fs.writeFileSync(
          path.join(root, shell.endsWith("bash") ? ".bashrc" : ".zshrc"),
          [
            "ls() { printf 'UNREVIEWED_FUNCTION\\n'; }",
            "env() { printf 'UNREVIEWED_WRAPPER\\n'; }",
            "alias cat=false",
            "export PATH=/unreviewed-path",
            "",
          ].join("\n"),
        );
        const review = reviewer();
        const result = await tool(review).execute("bound-dispatch", { command });
        if (result.details.status !== "completed") {
          throw new Error(`Unexpected exec status: ${result.details.status}`);
        }
        expect(review.mock.calls.length).toBe(1);
        expect(review.mock.calls[0]?.[0].command).toBe(command);
        expect(transport.call).not.toHaveBeenCalled();
        expect(result.details.exitCode).toBe(0);
        expect(result.details.aggregated).toContain("approved.txt");
        expect(result.details.aggregated).not.toContain("UNREVIEWED");
        expect(boundary.spawn.mock.calls.length).toBe(1);
      },
    );
  }

  it.skipIf(!python3).each([
    { mode: "auto", command: "python probe.py *.txt", shadowed: true },
    { mode: "ask", command: "python probe.py approved.txt", shadowed: false },
  ] as const)(
    "preserves the $mode virtualenv invocation or rejects PATH drift: $command (shadowed=$shadowed)",
    async ({ mode, command, shadowed }) => {
      if (!python3) {
        throw new Error("Python is required for this virtualenv regression");
      }
      const venv = path.join(root, "venv");
      const env = { HOME: root, PATH: "/usr/bin:/bin", PYTHONNOUSERSITE: "1" };
      execFileSync(python3, ["-m", "venv", "--without-pip", "--symlinks", venv], { env });
      const interpreter = path.join(venv, "bin", "python");
      expect(fs.lstatSync(interpreter).isSymbolicLink()).toBe(true);
      const sitePackages = execFileSync(
        interpreter,
        ["-c", "import sysconfig; print(sysconfig.get_paths()['purelib'])"],
        { env, encoding: "utf8" },
      ).trim();
      if (!sitePackages.startsWith(`${venv}${path.sep}`)) {
        throw new Error("The fixture must not write outside its virtualenv");
      }
      fs.writeFileSync(
        path.join(sitePackages, "venv_fixture.py"),
        "VALUE = 'venv-package-loaded'\n",
      );
      fs.writeFileSync(
        path.join(root, "probe.py"),
        "import sys, venv_fixture; print(venv_fixture.VALUE, *sys.argv[1:])\n",
      );
      fs.writeFileSync(path.join(root, "approved.txt"), "fixture");
      expect(
        execFileSync(interpreter, ["probe.py", "approved.txt"], {
          cwd: root,
          env,
          encoding: "utf8",
        }).trim(),
      ).toBe("venv-package-loaded approved.txt");
      const earlierBin = path.join(root, "earlier-bin");
      fs.mkdirSync(earlierBin);
      const review = reviewer();
      if (shadowed && mode === "auto") {
        review.mockImplementation(async () => {
          fs.symlinkSync(fs.realpathSync(interpreter), path.join(earlierBin, "python"));
          return { decision: "allow-once", risk: "low", rationale: "list fixture files" };
        });
      }
      if (mode === "ask") {
        approve("allow-once", () => {
          if (shadowed) {
            fs.symlinkSync(fs.realpathSync(interpreter), path.join(earlierBin, "python"));
          }
        });
      }
      // Gateway login-shell PATH is cached; select the fixture through its explicit exec setting.
      const result = await tool(review, mode, [earlierBin, path.dirname(interpreter)]).execute(
        "venv-review",
        { command },
      );
      expect(review.mock.calls.length).toBe(mode === "auto" ? 1 : 0);
      expect(
        transport.call.mock.calls.filter(
          ([options]) => options.method === "exec.approval.waitDecision",
        ).length,
      ).toBe(mode === "ask" ? 1 : 0);
      if (shadowed) {
        expect(result.details.status).toBe("failed");
        expect(boundary.spawn.mock.calls.length).toBe(0);
        return;
      }
      if (result.details.status !== "completed") {
        throw new Error(`Unexpected exec status: ${result.details.status}`);
      }
      expect(result.details.exitCode).toBe(0);
      expect(result.details.aggregated).toBe("venv-package-loaded approved.txt");
    },
  );

  it("keeps current-policy execution pinned when an allowlisted symlink changes", async () => {
    const bin = path.join(root, "bin");
    fs.mkdirSync(bin);
    const commandPath = path.join(bin, "read-approved");
    fs.symlinkSync("/bin/cat", commandPath);
    fs.writeFileSync(path.join(root, "approved.txt"), "approved-content\n");
    saveExecApprovals({
      version: 1,
      defaults: { security: "allowlist", ask: "off", askFallback: "deny" },
      agents: { main: { allowlist: [{ pattern: fs.realpathSync("/bin/cat") }] } },
    });
    boundary.prepare.mockImplementation(async () => {
      fs.unlinkSync(commandPath);
      fs.symlinkSync("/bin/echo", commandPath);
    });
    const review = reviewer();

    const result = await tool(review, "allowlist", [bin]).execute("allowlist-symlink", {
      command: "read-approved approved.txt",
    });

    expect(review.mock.calls.length).toBe(0);
    expect(transport.call).not.toHaveBeenCalled();
    if (result.details.status !== "completed") {
      throw new Error(`Unexpected exec status: ${result.details.status}`);
    }
    expect(result.details.exitCode).toBe(0);
    expect(result.details.aggregated).toBe("approved-content");
  });

  it("preserves startup customization for ordinary full-mode execution", async () => {
    saveExecApprovals({ version: 1, defaults: { security: "full", ask: "off" }, agents: {} });
    fs.writeFileSync(path.join(root, ".bashrc"), "ls() { printf 'CUSTOMIZED\\n'; }\n");
    const review = reviewer();
    const result = await tool(review, "full").execute("full-customization", {
      command: "ls *.txt",
    });
    expect(review.mock.calls.length).toBe(0);
    if (result.details.status !== "completed") {
      throw new Error(`Unexpected exec status: ${result.details.status}`);
    }
    expect(result.details.aggregated).toBe("CUSTOMIZED");
  });

  it.each(["auto", "human-always", "current-policy"] as const)(
    "revalidates %s after asynchronous shell preparation",
    async (authority) => {
      vi.stubEnv("OPENCLAW_EXEC_SHELL_SNAPSHOT", "0");
      fs.writeFileSync(path.join(root, "approved.txt"), "fixture");
      setPolicy("allowlist", authority === "current-policy");
      const review = reviewer();
      approve(authority === "human-always" ? "allow-always" : "allow-once");
      boundary.prepare.mockImplementation(async () => setPolicy("deny"));
      const mode =
        authority === "current-policy" ? "allowlist" : authority === "auto" ? "auto" : "ask";
      const pending = tool(review, mode).execute("policy-revalidation", {
        command: "/bin/ls approved.txt",
      });
      await expect(pending).rejects.toThrow("Exec approval changed before execution");
      expect(boundary.spawn.mock.calls.length).toBe(0);
      expect(review.mock.calls.length).toBe(authority === "auto" ? 1 : 0);
      expect(boundary.prepare.mock.calls.length).toBe(1);
      expect(loadExecApprovalsReadOnly().defaults?.security).toBe("deny");
    },
  );

  it("rechecks policy after deferred supervisor admission", async () => {
    let started = 0;
    const liveSupervisor = supervisor!;
    boundary.spawn.mockImplementation(async (input) => {
      await Promise.resolve();
      setPolicy("deny");
      const run = await liveSupervisor.spawn(input);
      started += 1;
      return run;
    });
    await expect(
      tool(reviewer()).execute("deferred-admission", { command: "/bin/ls" }),
    ).rejects.toThrow("Exec approval changed before execution");
    expect(started).toBe(0);
  });

  it.each([false, true])(
    "preserves human allow-always through PTY fallback (revoked=%s)",
    async (revoked) => {
      fs.writeFileSync(path.join(root, "approved.txt"), "fixture");
      approve("allow-always");
      const liveSupervisor = supervisor!;
      let started = 0;
      boundary.spawn.mockImplementation(async (input) => {
        if (input.mode === "pty") {
          if (revoked) {
            setPolicy("deny");
          }
          throw new Error("fixture PTY unavailable");
        }
        const run = await liveSupervisor.spawn(input);
        started += 1;
        return run;
      });
      const pending = tool(reviewer(), "ask").execute("pty-revalidation", {
        command: "/bin/ls approved.txt",
        pty: true,
      });
      if (revoked) {
        await expect(pending).rejects.toThrow("Exec approval changed before execution");
        expect(started).toBe(0);
      } else {
        const result = await pending;
        if (result.details.status !== "completed") {
          throw new Error(`Unexpected exec status: ${result.details.status}`);
        }
        expect(result.details.aggregated).toBe("approved.txt");
        expect(started).toBe(1);
        expect((loadExecApprovalsReadOnly().agents?.main?.allowlist ?? []).length).toBeGreaterThan(
          0,
        );
      }
    },
  );

  // One verified chat.send caller and the ordinary no-authority path exercise the real
  // tool/gateway approval routing; only the network transport is replaced.
  it.each([true, false])(
    "runs direct bash approval routing with explicit authority=%s",
    async (withAuthority) => {
      saveExecApprovals({
        version: 1,
        defaults: { security: "allowlist", ask: "on-miss", askFallback: "deny" },
        agents: {},
      });
      fs.writeFileSync(path.join(root, "approved.txt"), "fixture");
      approve("allow-once");
      const body = `! /bin/ls ${path.join(root, "approved.txt")}`;
      let input: ReturnType<typeof createHandleInlineActionsInput>;
      if (withAuthority) {
        const ctx = verifiedChatSendInput(body);
        const cfg: OpenClawConfig = {
          commands: {
            bash: true,
            text: true,
            ownerAllowFrom: ["profile-ada"],
            allowFrom: { webchat: ["profile-ada"] },
          },
          tools: { elevated: { enabled: true, allowFrom: { webchat: ["profile-ada"] } } },
          agents: {
            entries: {
              main: {
                tools: { elevated: { enabled: true, allowFrom: { webchat: ["profile-ada"] } } },
              },
            },
          },
        };
        expect(
          resolveElevatedPermissions({
            cfg,
            agentId: "main",
            ctx,
            provider: ctx.Provider ?? "",
          }),
        ).toEqual({ enabled: true, allowed: true, failures: [] });
        input = chatBashInput({
          body,
          ctx,
          cfg,
          operatorAuthority: callerAuthority(),
          command: resolveCommandAuthorization({ ctx, cfg, commandAuthorized: true }),
        });
      } else {
        input = chatBashInput({ body });
      }

      const result = await handleInlineActions(input);

      const text = chatBashReplyText(result);
      expect(text).toContain("Exit: code 0");
      expect(text).toContain("approved.txt");
      const registered = transport.call.mock.calls.find(
        ([options]) => options.method === "exec.approval.request",
      )?.[0].params as { id?: string } | undefined;
      const waited = transport.call.mock.calls.find(
        ([options]) => options.method === "exec.approval.waitDecision",
      )?.[0].params;
      expect(registered).toMatchObject({ host: "gateway", ask: "on-miss", twoPhase: true });
      expect(registered?.id).toBeTruthy();
      expect(waited).toEqual({ id: registered?.id });
      expect(boundary.spawn.mock.calls.length).toBe(1);
    },
  );

  it("rejects an explicit revoked authority even with valid ambient authority", async () => {
    saveExecApprovals({ version: 1, defaults: { security: "full", ask: "off" }, agents: {} });
    const revoked = new AbortController();
    const explicitAuthority = callerAuthority(revoked.signal);
    revoked.abort(new Error("explicit authority revoked"));
    const explicitTool = createExecToolForReply({
      defaults: {
        agentId: "main",
        host: "gateway",
        mode: "full",
        autoReviewer: reviewer(),
        cwd: root,
        runId: "explicit-authority",
        messageProvider: "webchat",
        nonInteractiveApproval: true,
        notifyOnExit: false,
        elevated: elevatedDefaults,
      },
      operatorAuthority: explicitAuthority,
    });

    await expect(
      withGatewayToolCallerIdentity(
        { agentId: "main", sessionKey: "agent:main:main", operatorAuthority: callerAuthority() },
        () =>
          explicitTool.execute("explicit-authority", {
            command: "/bin/ls approved.txt",
            elevated: true,
          }),
      ),
    ).rejects.toThrow("explicit authority revoked");
    expect(boundary.spawn.mock.calls.length).toBe(0);
  });

  it.each([
    { kind: "operator authority", message: "chat bash caller revoked" },
    { kind: "reply abort", message: "chat bash reply operation cancelled" },
    { kind: "channel owner", message: "channel owner revoked" },
  ] as const)(
    "blocks direct bash spawn when the $kind ends during preparation",
    async ({ kind, message }) => {
      const approvedPath = path.join(root, "approved.txt");
      fs.writeFileSync(approvedPath, "fixture");
      const body = `! /bin/ls ${approvedPath}`;
      const revoked = new AbortController();
      const operatorAuthority = callerAuthority(
        kind === "reply abort" ? undefined : revoked.signal,
      );
      const ctx =
        kind === "channel owner"
          ? buildTestCtx({
              Body: body,
              CommandBody: body,
              CommandAuthorized: true,
              ChatType: "direct",
              Provider: "telegram",
              Surface: "telegram",
              OriginatingChannel: "telegram",
              From: "telegram:42",
              To: "telegram:99",
              SenderId: "42",
            })
          : undefined;
      if (ctx) {
        bindCommandOwnerAuthority(ctx, { isCurrent: () => true, operatorAuthority });
      }
      const opts = ctx ? prepareInternalGetReplyOptions(undefined, ctx) : undefined;
      if (ctx) {
        expect(opts?.operatorAuthority).toBe(operatorAuthority);
      }
      boundary.prepare.mockImplementation(async () => {
        revoked.abort(new Error(message));
      });
      approve("allow-once");

      const result = await handleInlineActions(
        chatBashInput({
          body,
          ctx,
          operatorAuthority,
          abortSignal: kind === "reply abort" ? revoked.signal : undefined,
          opts,
        }),
      );

      expect(chatBashReplyText(result)).toContain(message);
      expect(gatewayMethods()).toContain("exec.approval.request");
      expect(gatewayMethods()).toContain("exec.approval.waitDecision");
      expect(boundary.prepare).toHaveBeenCalled();
      expect(boundary.spawn.mock.calls.length).toBe(0);
    },
  );

  it("cancels a retained direct bash session when its live authority ends after reply", async () => {
    saveExecApprovals({ version: 1, defaults: { security: "full", ask: "off" }, agents: {} });
    const revoked = new AbortController();
    const operatorAuthority = callerAuthority(revoked.signal);

    const started = await handleInlineActions(
      chatBashInput({ body: "! sleep 30", operatorAuthority, bashForegroundMs: 0 }),
    );
    const sessionId = chatBashReplyText(started).match(/session ([^)]+)\)/)?.[1];
    if (!sessionId) {
      throw new Error("Expected a retained bash session");
    }
    const session = getSession(sessionId);
    if (!session) {
      throw new Error("Expected the retained session");
    }
    expect(boundary.spawn.mock.calls.length).toBe(1);

    revoked.abort(new Error("chat bash caller revoked after spawn"));
    await waitForExecSession(session);
    expect(getFinishedSession(sessionId)).toMatchObject({
      exited: true,
      exitReason: "manual-cancel",
    });
    // Clear the command module's active-job record before the next case.
    await handleInlineActions(chatBashInput({ body: "!stop" }));
  });
});
