import { randomBytes } from "node:crypto";
import { parseModelRef } from "openclaw/plugin-sdk/model-ref-parse";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type { CommandOptions } from "openclaw/plugin-sdk/process-runtime";
import {
  withConfiguredModelEgress,
  type ConfiguredModelEgress,
} from "openclaw/plugin-sdk/secret-egress-runtime";
import { shellEscape } from "openclaw/plugin-sdk/string-normalization-runtime";
import { resolveCrabboxBinary } from "./crabbox-binary.js";
import { ensureManagedCrabboxBinary } from "./crabbox-managed-binary.js";
import { runCrabboxProcess } from "./crabbox-process.js";

const UPSTREAM_PROXY_ENV = "CRABBOX_MODEL_PROXY";
const MAX_OUTPUT_BYTES = 1024 * 1024;

type CliContext = Parameters<Parameters<OpenClawPluginApi["registerCli"]>[0]>[0];

function shellQuote(value: string): string {
  if (value.includes("\0")) {
    throw new Error("Crabbox model command cannot contain NUL bytes");
  }
  return shellEscape(value);
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

export function registerCrabboxModelRunCommand({
  program,
  config,
}: Pick<CliContext, "program" | "config">): void {
  const crabbox =
    program.commands.find((command) => command.name() === "crabbox") ?? program.command("crabbox");
  crabbox.description("Run model-backed commands and manage Crabbox warm images");
  crabbox
    .command("run")
    .description(
      "Run a foreground command on an exclusive Linux lease using a protected model credential",
    )
    .requiredOption("--id <lease>", "Existing, exclusively owned Crabbox lease")
    .requiredOption("--model <provider/model>", "Configured OpenAI-compatible API-key model")
    .option("--provider <provider>", "Crabbox backend override; otherwise use the lease's provider")
    .option("--binary <path>", "Preferred Crabbox binary (managed release used if outdated)")
    .option("--timeout <seconds>", "Total command and setup deadline in seconds", "600")
    .argument("<command...>", "Remote executable and arguments, following --")
    .action(
      async (
        argv: string[],
        options: {
          id: string;
          model: string;
          provider?: string;
          binary?: string;
          timeout: string;
        },
      ) => {
        const seconds = Number(options.timeout);
        if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > 86_400) {
          throw new Error("--timeout must be an integer between 1 and 86400 seconds");
        }
        const controller = new AbortController();
        const cancel = () => controller.abort(new Error("Crabbox model command interrupted"));
        process.once("SIGINT", cancel);
        process.once("SIGTERM", cancel);
        try {
          const preferredBinary = resolveCrabboxBinary({
            explicit: options.binary,
            pathEnv: process.env.PATH,
          });
          const { id, model: modelRef, provider } = options;
          const timeoutMs = seconds * 1000;
          const model = parseModelRef(modelRef, "");
          if (!modelRef.includes("/") || !model?.provider || !model.model) {
            throw new Error("--model must name an explicit provider/model");
          }
          const signal = AbortSignal.any([AbortSignal.timeout(timeoutMs), controller.signal]);
          const { binary } = await ensureManagedCrabboxBinary({ binary: preferredBinary, signal });
          const command = (
            args: string[],
            commandOptions: Pick<CommandOptions, "env" | "input" | "onOutputChunk"> = {},
          ) =>
            runCrabboxProcess([binary, "egress", "run", ...args], {
              timeoutMs,
              maxOutputBytes: MAX_OUTPUT_BYTES,
              killProcessTree: true,
              requireProcessTreeExtinction: true,
              // Native egress owns remote cleanup after SIGTERM; credential use ends immediately.
              killGraceMs: 75_000,
              signal,
              ...commandOptions,
              env: {
                CRABBOX_ENV_ALLOW: ",",
                [UPSTREAM_PROXY_ENV]: undefined,
                ...commandOptions.env,
              },
            });
          const help = await command(["--help"]);
          if (
            help.termination !== "exit" ||
            help.code !== 0 ||
            !/(?:^|\n)\s+-{1,2}upstream-proxy-env(?:\s|$)/u.test(`${help.stdout}\n${help.stderr}`)
          ) {
            throw new Error(
              "This Crabbox binary lacks native egress run support; update Crabbox first",
            );
          }
          const result = await withConfiguredModelEgress(
            {
              config,
              ...model,
              signal,
              onOutput: (text, stream) => {
                process[stream].write(text);
              },
            },
            async (egress) => {
              const output = await command(
                [
                  "--id",
                  id,
                  ...(provider ? ["--provider", provider] : []),
                  "--allow",
                  egress.allowedHosts.join(","),
                  "--upstream-proxy-env",
                  UPSTREAM_PROXY_ENV,
                  "--no-sync",
                  "--no-hydrate",
                  "--script-stdin",
                  "--",
                  ...argv,
                ],
                {
                  env: { [UPSTREAM_PROXY_ENV]: egress.hostEnv.HTTPS_PROXY },
                  input: remoteCommandScript(egress),
                  onOutputChunk: egress.onOutputChunk,
                },
              );
              if (output.cleanup === "uncertain") {
                throw new Error("Crabbox could not confirm that the command stopped");
              }
              return output;
            },
          );
          process.exitCode = result.termination === "exit" ? (result.code ?? 1) : 1;
        } finally {
          process.off("SIGINT", cancel);
          process.off("SIGTERM", cancel);
        }
      },
    );
}
