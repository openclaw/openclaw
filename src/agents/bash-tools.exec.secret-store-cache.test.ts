/** Regression test for #152409: the exec tool caches its store environment snapshot
 * per instance, keyed on the store mutations version. A protected secret written
 * mid-session (the masked secrets.request flow) must be visible to later exec
 * calls in the same session instead of expanding to an empty variable. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { saveExecApprovals, type ExecApprovalsFile } from "../infra/exec-approvals.js";
// saveExecApprovals stays for the allowlist file; the authorization commit is mocked above so the
// shared-state SQLite broker is never required (in-process tests have no host broker).
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import { resetProcessRegistryForTests } from "./bash-process-registry.test-support.js";
import { createExecTool as createExecToolImpl } from "./bash-tools.exec-run.js";
import { callGatewayTool } from "./tools/gateway.js";

const storeMocks = vi.hoisted(() => ({
  readSecretStoreExecEnvironment: vi.fn(),
  getSecretStoreMutationsVersion: vi.fn(() => 0),
  commitExecAuthorizationLocked: vi.fn(async () => () => {}),
}));
vi.mock("../secrets/store/secret-store.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  readSecretStoreExecEnvironment: storeMocks.readSecretStoreExecEnvironment,
  getSecretStoreMutationsVersion: storeMocks.getSecretStoreMutationsVersion,
}));

vi.mock("../infra/exec-approvals.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/exec-approvals.js")>()),
  commitExecAuthorizationLocked: storeMocks.commitExecAuthorizationLocked,
}));

vi.mock("../state/openclaw-state-worker-store.js", async (importOriginal) => {
  const mod = await importOriginal<object>();
  return {
    ...mod,
    runOpenClawStateWorkerOperation: (context: unknown, op: unknown, opts: unknown) => {
      console.log("WORKER OP STACK:\n" + new Error().stack);
      return (
        mod as { runOpenClawStateWorkerOperation: (...a: unknown[]) => Promise<unknown> }
      ).runOpenClawStateWorkerOperation(context, op, opts);
    },
  };
});
vi.mock("../secrets/egress-proxy/registry.js", async (importOriginal) => {
  const mod = await importOriginal<object>();
  return {
    ...mod,
    isSecretEgressProxyActive: () => true,
    registerSecretEgressProxyProcess: () => ({ env: {}, revoke: () => {} }),
  };
});
vi.mock("./simple-completion-runtime.js", () => ({
  acquireSimpleCompletionModelForAgent: vi.fn(),
  completeWithPreparedSimpleCompletionModel: vi.fn(),
}));
vi.mock("./tools/gateway.js", () => ({
  callGatewayTool: vi.fn(),
  readGatewayCallOptions: vi.fn(() => ({})),
}));

describe("exec store-env cache invalidation (#152409)", () => {
  let envSnapshot: ReturnType<typeof captureEnv>;
  let tempRoot: string | undefined;

  beforeEach(() => {
    envSnapshot = captureEnv([
      "HOME",
      "USERPROFILE",
      "OPENCLAW_HOME",
      "OPENCLAW_STATE_DIR",
      "SHELL",
    ]);
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-exec-store-cache-"));
    setTestEnvValue("HOME", tempRoot);
    setTestEnvValue("USERPROFILE", tempRoot);
    setTestEnvValue("OPENCLAW_HOME", tempRoot);
    setTestEnvValue("OPENCLAW_STATE_DIR", path.join(tempRoot, "state"));
    resetProcessRegistryForTests();
    vi.mocked(callGatewayTool).mockReset();
    storeMocks.readSecretStoreExecEnvironment.mockReset();
    storeMocks.readSecretStoreExecEnvironment.mockReturnValue({});
    storeMocks.getSecretStoreMutationsVersion.mockReturnValue(0);

    // allowlisted probe script that prints the env var (same pattern as the security-floor tests)
    const binDir = path.join(tempRoot, "bin");
    fs.mkdirSync(binDir, { recursive: true });
    const probePath = path.join(binDir, "env-probe");
    fs.writeFileSync(probePath, "#!/bin/sh\nprintf '%s' \"$META_ADS_ACCESS_TOKEN\"\n", {
      mode: 0o755,
    });
    saveExecApprovals({
      version: 1,
      defaults: { security: "allowlist", ask: "off", askFallback: "allowlist" },
      agents: { "*": { allowlist: [{ pattern: probePath }] } },
    } as unknown as ExecApprovalsFile);
  });

  afterEach(() => {
    const dir = tempRoot;
    tempRoot = undefined;
    envSnapshot.restore();
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });

  it("re-reads the store after a mid-session mutation; cached read reused when unchanged", async () => {
    const binDir = path.join(tempRoot!, "bin");
    const tool = createExecToolImpl({
      agentId: "main",
      host: "gateway",
      security: "allowlist",
      ask: "off",
      safeBins: [],
      pathPrepend: [binDir],
      operationalRunInstance: { instanceId: "inst-test", runId: "run-test" },
    });
    const probe = { command: "env-probe" };

    // first exec: no secret in the store yet -> variable expands empty
    const before = await tool.execute("call-1", probe);
    expect(["", "(no output)"]).toContain(resultText(before));

    // masked secrets.request flow stores the token: version bumps, fresh read carries the sentinel
    const sentinel = "oc-sent-v2.synthetic.end";
    storeMocks.getSecretStoreMutationsVersion.mockReturnValue(1);
    storeMocks.readSecretStoreExecEnvironment.mockReturnValue({
      secretSentinels: { META_ADS_ACCESS_TOKEN: sentinel },
    });

    const after = await tool.execute("call-2", probe);
    expect(resultText(after)).toBe(sentinel);

    // unchanged version: cached snapshot reused, no additional store reads
    const readsBefore = storeMocks.readSecretStoreExecEnvironment.mock.calls.length;
    await tool.execute("call-3", probe);
    expect(storeMocks.readSecretStoreExecEnvironment.mock.calls.length).toBe(readsBefore);
  });

  it("keeps ordinary env entries run-stable across store mutations (P1 review fix)", async () => {
    const binDir = path.join(tempRoot!, "bin");
    const probePath = path.join(binDir, "env-probe-plain");
    fs.writeFileSync(probePath, "#!/bin/sh\nprintf '%s' \"$AWS_REGION\"\n", { mode: 0o755 });
    saveExecApprovals({
      version: 1,
      defaults: { security: "allowlist", ask: "off", askFallback: "allowlist" },
      agents: { "*": { allowlist: [{ pattern: probePath }] } },
    } as unknown as ExecApprovalsFile);

    const tool = createExecToolImpl({
      agentId: "main",
      host: "gateway",
      security: "allowlist",
      ask: "off",
      safeBins: [],
      pathPrepend: [binDir],
      operationalRunInstance: { instanceId: "inst-plain", runId: "run-plain" },
    });

    // first read: an ordinary env row exists
    storeMocks.readSecretStoreExecEnvironment.mockReturnValueOnce({
      env: { AWS_REGION: "us-east-1" },
    });
    const before = await tool.execute("plain-1", { command: "env-probe-plain" });
    expect(resultText(before)).toBe("us-east-1");

    // a mid-session store mutation (secret write) must NOT refresh ordinary env:
    // the documented run-stable contract holds even while the version advances.
    storeMocks.getSecretStoreMutationsVersion.mockReturnValue(7);
    storeMocks.readSecretStoreExecEnvironment.mockReturnValue({
      env: { AWS_REGION: "eu-west-1" },
      secretSentinels: { META_ADS_ACCESS_TOKEN: "oc-sent-x.synthetic.end" },
    });
    const after = await tool.execute("plain-2", { command: "env-probe-plain" });
    expect(resultText(after)).toBe("us-east-1");
  });
});

type ExecResult = { content?: { type: string; text?: string }[] };
function resultText(r: unknown): string {
  const res = r as ExecResult;
  return res.content?.find((c) => typeof c.text === "string")?.text ?? "";
}
