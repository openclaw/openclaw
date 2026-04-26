import { execFile } from "node:child_process";
import { homedir, platform } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { SecretProviderPlugin } from "openclaw/plugin-sdk/secret-provider";

const execFileAsync = promisify(execFile);

type KeyringConfig = {
  source: "keyring";
  service?: string;
  keychainPath?: string;
};

const DEFAULT_SERVICE = "openclaw";

async function resolveDarwinSecret(params: {
  refId: string;
  providerName: string;
  service: string;
  keychainPath: string;
}): Promise<string> {
  try {
    const { stdout } = await execFileAsync("security", [
      "find-generic-password",
      "-a",
      params.service,
      "-s",
      params.refId,
      "-w",
      params.keychainPath,
    ]);
    return stdout.trimEnd();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Keyring secret "${params.refId}" not found (provider: ${params.providerName}, service: ${params.service}): ${msg}`,
      { cause: err },
    );
  }
}

async function resolveLinuxSecret(params: {
  refId: string;
  providerName: string;
  service: string;
}): Promise<string> {
  try {
    const { stdout } = await execFileAsync("secret-tool", [
      "lookup",
      "service",
      params.service,
      "key",
      params.refId,
    ]);
    const value = stdout.trimEnd();
    if (!value) {
      throw new Error("empty result");
    }
    return value;
  } catch {
    throw new Error(
      `Keyring secret "${params.refId}" not found (provider: ${params.providerName}, service: ${params.service}). Ensure secret-tool is installed and the secret exists.`,
    );
  }
}

export function createKeyringSecretProvider(): SecretProviderPlugin {
  return {
    id: "keyring",
    label: "OS Keyring",
    async resolve(ctx) {
      const cfg = ctx.providerConfig as KeyringConfig;
      const service = cfg.service ?? DEFAULT_SERVICE;
      const os = platform();
      const out = new Map<string, unknown>();

      if (os === "darwin") {
        const keychainPath =
          cfg.keychainPath ?? path.join(homedir(), "Library", "Keychains", "openclaw.keychain-db");
        for (const ref of ctx.refs) {
          out.set(
            ref.id,
            await resolveDarwinSecret({
              refId: ref.id,
              providerName: ctx.providerName,
              service,
              keychainPath,
            }),
          );
        }
        return out;
      }

      if (os === "linux") {
        for (const ref of ctx.refs) {
          out.set(
            ref.id,
            await resolveLinuxSecret({
              refId: ref.id,
              providerName: ctx.providerName,
              service,
            }),
          );
        }
        return out;
      }

      throw new Error(
        `OS keyring provider is not supported on platform: ${os}. Supported: macOS (security CLI), Linux (secret-tool).`,
      );
    },
  };
}
