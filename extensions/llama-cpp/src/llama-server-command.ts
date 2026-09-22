import { execFile } from "node:child_process";
import { resolveCommandEnv } from "openclaw/plugin-sdk/process-runtime";

const COMMAND_TIMEOUT_MS = 15_000;

export async function runLlamaServerCommand(
  command: string,
  args: string[],
  signal?: AbortSignal,
  timeoutMs = COMMAND_TIMEOUT_MS,
  context: { env?: NodeJS.ProcessEnv; cwd?: string } = {},
): Promise<string> {
  signal?.throwIfAborted();
  return await new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      {
        timeout: timeoutMs,
        signal,
        windowsHide: true,
        ...(context.cwd === undefined ? {} : { cwd: context.cwd }),
        ...(context.env === undefined
          ? {}
          : { env: resolveCommandEnv({ argv: [command, ...args], env: context.env }) }),
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(error.message, { cause: error }));
        } else {
          resolve(`${stdout}${stderr}`.trim());
        }
      },
    );
  });
}

type LlamaServerDevice = {
  id: string;
  name: string;
  totalMemoryBytes: number;
  availableMemoryBytes: number;
};

/** Read the installed backend's device names under the eventual service environment. */
export async function listLlamaServerDevices(options: {
  command: string;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  signal?: AbortSignal;
}): Promise<LlamaServerDevice[]> {
  const output = await runLlamaServerCommand(
    options.command,
    ["--list-devices"],
    options.signal,
    COMMAND_TIMEOUT_MS,
    options,
  );
  options.signal?.throwIfAborted();
  const devices: LlamaServerDevice[] = [];
  const seen = new Set<string>();
  for (const line of output.split(/\r?\n/u)) {
    const match = /^\s*(\S+): (.+) \((\d+) MiB, (\d+) MiB free\)$/u.exec(line);
    if (!match) {
      continue;
    }
    const [, id, name, total, available] = match;
    const totalMemoryBytes = Number(total) * 1024 ** 2;
    const availableMemoryBytes = Number(available) * 1024 ** 2;
    if (
      !id ||
      !name ||
      !Number.isSafeInteger(totalMemoryBytes) ||
      totalMemoryBytes <= 0 ||
      !Number.isSafeInteger(availableMemoryBytes) ||
      availableMemoryBytes < 0
    ) {
      continue;
    }
    if (seen.has(id)) {
      throw new Error(
        `llama-server reported duplicate device ${id}. Check the runtime and retry setup.`,
      );
    }
    seen.add(id);
    devices.push({ id, name, totalMemoryBytes, availableMemoryBytes });
  }
  return devices;
}
