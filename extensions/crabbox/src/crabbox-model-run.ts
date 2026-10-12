import { randomBytes } from "node:crypto";
import { redactSensitiveText } from "openclaw/plugin-sdk/logging-core";
import { parseModelRef } from "openclaw/plugin-sdk/model-ref-parse";
import type { OpenClawConfig } from "openclaw/plugin-sdk/plugin-entry";
import {
  runCommandWithTimeout,
  type CommandOptions,
  type SpawnResult,
} from "openclaw/plugin-sdk/process-runtime";
import {
  withConfiguredModelEgress,
  type ConfiguredModelEgress,
} from "openclaw/plugin-sdk/secret-egress-runtime";

const UPSTREAM_PROXY_ENV = "CRABBOX_MODEL_PROXY";
const MAX_OUTPUT_BYTES = 1024 * 1024;

export type CrabboxModelRunOptions = {
  config: OpenClawConfig;
  binary: string;
  id: string;
  model: string;
  provider?: string;
  argv: string[];
  timeoutMs: number;
  signal?: AbortSignal;
  onOutput?: (text: string, stream: "stdout" | "stderr") => void;
};

function shellQuote(value: string): string {
  if (value.includes("\0")) {
    throw new Error("Crabbox model command cannot contain NUL bytes");
  }
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function remoteCommandScript(egress: ConfiguredModelEgress): string {
  const delimiter = `MODEL_EGRESS_CA_${randomBytes(12).toString("hex")}`;
  return `#!/bin/bash
set -euo pipefail
umask 077
egress_dir=$(mktemp -d)
trap 'rm -rf -- "$egress_dir"' EXIT
cat > "$egress_dir/ca.pem" <<'${delimiter}'
${egress.caBundle}
${delimiter}
export OPENAI_API_KEY=${shellQuote(egress.sentinel)}
export OPENAI_BASE_URL=${shellQuote(egress.baseUrl)}
export OPENAI_MODEL=${shellQuote(egress.model)}
export HTTPS_PROXY=http://127.0.0.1:3128 HTTP_PROXY=http://127.0.0.1:3128
export https_proxy="$HTTPS_PROXY" http_proxy="$HTTP_PROXY"
export NO_PROXY=localhost,127.0.0.1,::1 no_proxy=localhost,127.0.0.1,::1
unset ALL_PROXY all_proxy
export NODE_USE_ENV_PROXY=1
export NODE_EXTRA_CA_CERTS="$egress_dir/ca.pem" SSL_CERT_FILE="$egress_dir/ca.pem"
export CURL_CA_BUNDLE="$egress_dir/ca.pem" REQUESTS_CA_BUNDLE="$egress_dir/ca.pem"
export GIT_SSL_CAINFO="$egress_dir/ca.pem"
"$@"
`;
}

export async function runCrabboxModelCommand(params: CrabboxModelRunOptions): Promise<SpawnResult> {
  const model = parseModelRef(params.model, "");
  if (!params.model.includes("/") || !model?.provider || !model.model) {
    throw new Error("--model must name an explicit provider/model");
  }
  const signal = AbortSignal.any([
    AbortSignal.timeout(params.timeoutMs),
    ...(params.signal ? [params.signal] : []),
  ]);
  const command = (
    args: string[],
    options: Pick<CommandOptions, "env" | "input" | "onOutputChunk"> = {},
  ) =>
    runCommandWithTimeout([params.binary, "egress", "run", ...args], {
      timeoutMs: params.timeoutMs,
      maxOutputBytes: MAX_OUTPUT_BYTES,
      killProcessTree: true,
      requireProcessTreeExtinction: true,
      // Native egress owns remote cleanup after SIGTERM; credential use ends immediately.
      killGraceMs: 75_000,
      signal,
      ...options,
      env: { CRABBOX_ENV_ALLOW: ",", [UPSTREAM_PROXY_ENV]: undefined, ...options.env },
    });
  const help = await command(["--help"]);
  if (
    help.termination !== "exit" ||
    help.code !== 0 ||
    !/(?:^|\n)\s+-{1,2}upstream-proxy-env(?:\s|$)/u.test(`${help.stdout}\n${help.stderr}`)
  ) {
    throw new Error("This Crabbox binary lacks native egress run support; update Crabbox first");
  }
  return await withConfiguredModelEgress(
    { config: params.config, ...model, signal, onOutput: params.onOutput },
    async (egress) => {
      const result = await command(
        [
          "--id",
          params.id,
          ...(params.provider ? ["--provider", params.provider] : []),
          "--allow",
          egress.allowedHosts.join(","),
          "--upstream-proxy-env",
          UPSTREAM_PROXY_ENV,
          "--no-sync",
          "--no-hydrate",
          "--script-stdin",
          "--",
          ...params.argv,
        ],
        {
          env: { [UPSTREAM_PROXY_ENV]: egress.hostEnv.HTTPS_PROXY },
          input: remoteCommandScript(egress),
          onOutputChunk: egress.onOutputChunk,
        },
      );
      if (result.cleanup === "uncertain") {
        throw new Error("Crabbox could not confirm that the command stopped");
      }
      return {
        ...result,
        stdout: redactSensitiveText(result.stdout),
        stderr: redactSensitiveText(result.stderr),
      };
    },
  );
}
