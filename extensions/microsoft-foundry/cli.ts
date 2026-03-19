import { execFile, execFileSync, spawn } from "node:child_process";
import type { AzAccessToken, AzAccount } from "./shared.js";
import { COGNITIVE_SERVICES_RESOURCE } from "./shared.js";

export function execAz(args: string[]): string {
  return execFileSync("az", args, {
    encoding: "utf-8",
    timeout: 30_000,
    shell: process.platform === "win32",
  }).trim();
}

export async function execAzAsync(args: string[]): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    execFile(
      "az",
      args,
      {
        encoding: "utf-8",
        timeout: 30_000,
        shell: process.platform === "win32",
      },
      (error, stdout, stderr) => {
        if (error) {
          const details = `${String(stderr ?? "").trim()} ${String(stdout ?? "").trim()}`.trim();
          reject(
            new Error(
              details ? `${error.message}: ${details}` : error.message,
            ),
          );
          return;
        }
        resolve(String(stdout).trim());
      },
    );
  });
}

export function isAzCliInstalled(): boolean {
  try {
    execAz(["version", "--output", "none"]);
    return true;
  } catch {
    return false;
  }
}

export function getLoggedInAccount(): AzAccount | null {
  try {
    return JSON.parse(execAz(["account", "show", "--output", "json"])) as AzAccount;
  } catch {
    return null;
  }
}

export function listSubscriptions(): AzAccount[] {
  try {
    const subs = JSON.parse(execAz(["account", "list", "--output", "json", "--all"])) as AzAccount[];
    return subs.filter((sub) => sub.state === "Enabled");
  } catch {
    return [];
  }
}

export function getAccessTokenResult(params?: {
  subscriptionId?: string;
  tenantId?: string;
}): AzAccessToken {
  const args = [
    "account",
    "get-access-token",
    "--resource",
    COGNITIVE_SERVICES_RESOURCE,
    "--output",
    "json",
  ];
  if (params?.subscriptionId) {
    args.push("--subscription", params.subscriptionId);
  } else if (params?.tenantId) {
    args.push("--tenant", params.tenantId);
  }
  return JSON.parse(execAz(args)) as AzAccessToken;
}

export async function getAccessTokenResultAsync(params?: {
  subscriptionId?: string;
  tenantId?: string;
}): Promise<AzAccessToken> {
  const args = [
    "account",
    "get-access-token",
    "--resource",
    COGNITIVE_SERVICES_RESOURCE,
    "--output",
    "json",
  ];
  if (params?.subscriptionId) {
    args.push("--subscription", params.subscriptionId);
  } else if (params?.tenantId) {
    args.push("--tenant", params.tenantId);
  }
  return JSON.parse(await execAzAsync(args)) as AzAccessToken;
}

export async function azLoginDeviceCode(): Promise<void> {
  return azLoginDeviceCodeWithOptions({});
}

export async function azLoginDeviceCodeWithOptions(params: {
  tenantId?: string;
  allowNoSubscriptions?: boolean;
}): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const maxCapturedLoginOutputChars = 8_000;
    const args = [
      "login",
      "--use-device-code",
      ...(params.tenantId ? ["--tenant", params.tenantId] : []),
      ...(params.allowNoSubscriptions ? ["--allow-no-subscriptions"] : []),
    ];
    const child = spawn("az", args, {
      stdio: ["inherit", "pipe", "pipe"],
      shell: process.platform === "win32",
    });
    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    const appendBoundedChunk = (chunks: string[], text: string): void => {
      if (!text) {
        return;
      }
      chunks.push(text);
      let totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
      while (totalLength > maxCapturedLoginOutputChars && chunks.length > 0) {
        const removed = chunks.shift();
        totalLength -= removed?.length ?? 0;
      }
    };
    child.stdout?.on("data", (chunk) => {
      const text = String(chunk);
      appendBoundedChunk(stdoutChunks, text);
      process.stdout.write(text);
    });
    child.stderr?.on("data", (chunk) => {
      const text = String(chunk);
      appendBoundedChunk(stderrChunks, text);
      process.stderr.write(text);
    });
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      const output = [...stderrChunks, ...stdoutChunks].join("").trim();
      reject(
        new Error(
          output ? `az login exited with code ${code}: ${output}` : `az login exited with code ${code}`,
        ),
      );
    });
    child.on("error", reject);
  });
}
