import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { resolveSignalCliConfigPath } from "./signal-cli-config-path.js";

export type SignalCliLinkResult =
  | { ok: true; associatedAccount?: string }
  | { ok: false; error: string };

export type SignalCliLinkCompletion = Promise<{ ok: boolean }>;

const SIGNAL_LINK_URI_PREFIX = "sgnl://linkdevice?";
const SIGNAL_LINK_ERROR_OUTPUT_LIMIT = 8_000;

function appendBoundedOutput(current: string, chunk: Buffer | string): string {
  const combined = current + String(chunk);
  return combined.length <= SIGNAL_LINK_ERROR_OUTPUT_LIMIT
    ? combined
    : combined.slice(-SIGNAL_LINK_ERROR_OUTPUT_LIMIT);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function spawnSignalCliLink(cliPath: string, args: string[]) {
  return spawn(cliPath, args, {
    stdio: ["ignore", "pipe", "pipe"],
  });
}

export async function linkSignalCliAccount(params: {
  cliPath: string;
  configPath?: string;
  abortSignal?: AbortSignal;
  onLinkUri: (uri: string, completion: SignalCliLinkCompletion) => Promise<void>;
}): Promise<SignalCliLinkResult> {
  const args = [
    ...(params.configPath?.trim()
      ? ["--config", resolveSignalCliConfigPath(params.configPath)]
      : []),
    "link",
    "-n",
    "OpenClaw",
  ];

  return await new Promise<SignalCliLinkResult>((resolve) => {
    let child: ReturnType<typeof spawnSignalCliLink>;
    try {
      child = spawnSignalCliLink(params.cliPath, args);
    } catch (error) {
      resolve({ ok: false, error: `Could not start signal-cli: ${errorMessage(error)}` });
      return;
    }

    let associatedAccount: string | undefined;
    let displayError: string | undefined;
    let displayPromise = Promise.resolve();
    let linkUriSeen = false;
    let stderr = "";
    let settled = false;
    let resolveCompletion!: (result: { ok: boolean }) => void;
    const completion = new Promise<{ ok: boolean }>((complete) => {
      resolveCompletion = complete;
    });
    const stdoutLines = createInterface({ input: child.stdout });
    const abortLink = () => {
      if (!child.killed) {
        child.kill("SIGTERM");
      }
    };

    stdoutLines.on("line", (line) => {
      const trimmed = line.trim();
      if (!linkUriSeen && trimmed.startsWith(SIGNAL_LINK_URI_PREFIX)) {
        if (params.abortSignal?.aborted) {
          return;
        }
        linkUriSeen = true;
        displayPromise = params.onLinkUri(trimmed, completion).catch((error: unknown) => {
          displayError = `Could not display the Signal linking QR code: ${errorMessage(error)}`;
          if (!child.killed) {
            child.kill("SIGTERM");
          }
        });
        return;
      }
      const associatedMatch = /^Associated with:\s*(\+\d{5,15})$/i.exec(trimmed);
      if (associatedMatch?.[1]) {
        associatedAccount = associatedMatch[1];
      }
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr = appendBoundedOutput(stderr, chunk);
    });

    const settle = (result: SignalCliLinkResult) => {
      if (settled) {
        return;
      }
      settled = true;
      params.abortSignal?.removeEventListener("abort", abortLink);
      stdoutLines.close();
      resolve(result);
    };

    if (params.abortSignal?.aborted) {
      abortLink();
    } else {
      params.abortSignal?.addEventListener("abort", abortLink, { once: true });
    }

    child.once("error", (error) => {
      resolveCompletion({ ok: false });
      settle({ ok: false, error: `Could not start signal-cli: ${errorMessage(error)}` });
    });
    child.once("close", (code, signal) => {
      // Signal approval is authoritative. Release a still-open QR prompt before
      // waiting for its callback so successful linking cannot deadlock config commit.
      resolveCompletion({ ok: code === 0 });
      void displayPromise.then(() => {
        if (displayError) {
          settle({ ok: false, error: displayError });
          return;
        }
        if (code !== 0) {
          const detail = stderr.trim();
          settle({
            ok: false,
            error:
              detail ||
              `signal-cli link exited with ${signal ? `signal ${signal}` : `code ${code ?? "unknown"}`}.`,
          });
          return;
        }
        if (!linkUriSeen) {
          settle({
            ok: false,
            error: "signal-cli link finished without producing a device-link QR code.",
          });
          return;
        }
        settle({
          ok: true,
          ...(associatedAccount ? { associatedAccount } : {}),
        });
      });
    });
  });
}
