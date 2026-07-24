import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { resolveUserPath } from "openclaw/plugin-sdk/text-utility-runtime";

export type SignalCliLinkResult =
  | { ok: true; associatedAccount?: string }
  | { ok: false; error: string };

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
  onLinkUri: (uri: string) => Promise<void>;
}): Promise<SignalCliLinkResult> {
  const args = [
    ...(params.configPath?.trim() ? ["--config", resolveUserPath(params.configPath.trim())] : []),
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
    const stdoutLines = createInterface({ input: child.stdout });

    stdoutLines.on("line", (line) => {
      const trimmed = line.trim();
      if (!linkUriSeen && trimmed.startsWith(SIGNAL_LINK_URI_PREFIX)) {
        linkUriSeen = true;
        displayPromise = params.onLinkUri(trimmed).catch((error: unknown) => {
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
      stdoutLines.close();
      resolve(result);
    };

    child.once("error", (error) => {
      settle({ ok: false, error: `Could not start signal-cli: ${errorMessage(error)}` });
    });
    child.once("close", (code, signal) => {
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
