import { randomBytes } from "node:crypto";
import { WorkerProviderError, type WorkerProvider } from "openclaw/plugin-sdk/plugin-entry";
import type { SpawnResult } from "openclaw/plugin-sdk/process-runtime";
import { withSetupSecretEgress } from "openclaw/plugin-sdk/secret-egress-runtime";
import type { SecretRef } from "openclaw/plugin-sdk/secret-ref-runtime";
import { runCrabboxProcess } from "./crabbox-process.js";
import type { LeaseCommandContext } from "./crabbox-worker-command.js";
import { runCrabboxCommand } from "./crabbox-worker-command.js";
import { assertCrabboxLeaseId, parseCrabboxProfile } from "./crabbox-worker-profile.js";

const UPSTREAM_PROXY_ENV = "CRABBOX_SETUP_PROXY";

function quote(value: string): string {
  if (value.includes("\0")) {
    throw new Error("Cloud setup environment cannot contain NUL");
  }
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export async function assertCrabboxSetupEgressSupport(params: {
  binary: string;
  target: string;
  assertCurrent: () => void;
  signal?: AbortSignal;
  projectPrepared?: boolean;
}): Promise<void> {
  params.assertCurrent();
  if (params.target !== "linux") {
    throw new Error("Setup secrets require a coordinator-owned Linux lease; select Linux");
  }
  if (params.projectPrepared === false) {
    throw new WorkerProviderError(
      "Protected repository setup requires a prepared Linux workspace; configure or select a machine class before retrying",
    );
  }
  const help = await runCrabboxCommand({
    ...params,
    action: "setup egress preflight",
    args: ["egress", "run", "--help"],
    timeoutMs: 30_000,
  });
  params.assertCurrent();
  const output = `${help.stdout}\n${help.stderr}`;
  if (
    help.termination !== "exit" ||
    help.code !== 0 ||
    !/(?:^|\n)\s+-{1,2}allow-public-destinations(?:\s|$)/u.test(output) ||
    !/(?:^|\n)\s+-{1,2}upstream-proxy-env(?:\s|$)/u.test(output)
  ) {
    throw new Error("Setup secrets require native egress; update Crabbox to 0.77.0 or newer");
  }
}

export function createCrabboxSetupCommandRunner(params: {
  resolveBinary: (binary?: string, signal?: AbortSignal) => Promise<string>;
}): NonNullable<WorkerProvider["runSetupCommand"]> {
  return async (lease, command) => {
    command.assertCurrent();
    const profile = parseCrabboxProfile(lease.profile);
    if (!Object.keys(profile.setupSecrets ?? {}).length) {
      return undefined;
    }
    assertCrabboxLeaseId(lease.leaseId);
    const binary = await params.resolveBinary(profile.binary, command.signal);
    const createScript = (env?: Record<string, string>) =>
      `set -eu\ncd -- ${quote(command.workspaceDir)}\nexport HOME=${quote(command.homeDir)}\nnode -e ${quote(command.createScript(env))}`;
    await assertCrabboxSetupEgressSupport({
      binary,
      target: profile.target,
      assertCurrent: command.assertCurrent,
      signal: command.signal,
    });
    return await runCrabboxSetupEgress({
      binary,
      provider: profile.provider,
      id: lease.leaseId,
      secrets: profile.setupSecrets ?? {},
      createScript,
      timeoutMs: command.timeoutMs,
      assertCurrent: command.assertCurrent,
      signal: command.signal,
    });
  };
}

/** The lease receives sentinels and public trust only; the upstream grant stays in the host child. */
export async function runCrabboxSetupEgress(
  params: LeaseCommandContext & {
    secrets: Readonly<Record<string, SecretRef>>;
    createScript: (env: Record<string, string>) => string;
    timeoutMs: number;
    assertCurrent: () => void;
    signal?: AbortSignal;
  },
): Promise<SpawnResult> {
  const signal = AbortSignal.any([
    AbortSignal.timeout(params.timeoutMs),
    ...(params.signal ? [params.signal] : []),
  ]);
  params.assertCurrent();
  return await withSetupSecretEgress({ secrets: params.secrets, signal }, async (egress) => {
    signal.throwIfAborted();
    params.assertCurrent();
    const directory = `/tmp/openclaw-setup-egress.${randomBytes(16).toString("hex")}`;
    const caFile = `${directory}/ca.pem`;
    const remoteEnv = {
      ...egress.remoteEnv,
      HTTPS_PROXY: "http://127.0.0.1:3128",
      https_proxy: "http://127.0.0.1:3128",
      NO_PROXY: "localhost,127.0.0.1,::1",
      no_proxy: "localhost,127.0.0.1,::1",
      NODE_USE_ENV_PROXY: "1",
      NODE_EXTRA_CA_CERTS: caFile,
      SSL_CERT_FILE: caFile,
      CURL_CA_BUNDLE: caFile,
      REQUESTS_CA_BUNDLE: caFile,
      GIT_SSL_CAINFO: caFile,
    };
    const delimiter = `SETUP_EGRESS_CA_${randomBytes(12).toString("hex")}`;
    const script = `#!/bin/bash
set -euo pipefail
umask 077
mkdir -- ${quote(directory)}
trap 'rm -rf -- ${quote(directory)}' EXIT
cat > ${quote(caFile)} <<'${delimiter}'
${egress.caBundle}
${delimiter}
unset HTTP_PROXY http_proxy ALL_PROXY all_proxy
${Object.entries(remoteEnv)
  .map(([name, value]) => `export ${name}=${quote(value)}`)
  .join("\n")}
${params.createScript(remoteEnv)}
`;
    const processAbort = new AbortController();
    const abort = () => {
      egress.revoke();
      processAbort.abort(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
    try {
      signal.throwIfAborted();
      params.assertCurrent();
      const result = await runCrabboxProcess(
        [
          params.binary,
          "egress",
          "run",
          "--id",
          params.id,
          "--provider",
          params.provider,
          "--allow-public-destinations",
          "--upstream-proxy-env",
          UPSTREAM_PROXY_ENV,
          "--no-sync",
          "--no-hydrate",
          "--script-stdin",
        ],
        {
          env: { CRABBOX_ENV_ALLOW: ",", [UPSTREAM_PROXY_ENV]: egress.hostEnv.HTTPS_PROXY },
          input: script,
          timeoutMs: params.timeoutMs,
          maxOutputBytes: 64 * 1024,
          killProcessTree: true,
          requireProcessTreeExtinction: true,
          killGraceMs: 75_000,
          signal: processAbort.signal,
        },
      );
      signal.throwIfAborted();
      params.assertCurrent();
      if (result.cleanup === "uncertain") {
        throw new Error("Setup egress cleanup is uncertain; stop the owned lease before retrying");
      }
      return result;
    } finally {
      egress.revoke();
      signal.removeEventListener("abort", abort);
    }
  });
}
