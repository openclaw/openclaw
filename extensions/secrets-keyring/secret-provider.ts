import { execFile } from "node:child_process";
import { homedir, platform } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { SecretProviderPlugin } from "openclaw/plugin-sdk/secret-provider";

const execFileAsync = promisify(execFile);

const SOURCE_ID = "keyring";
const DEFAULT_SERVICE = "openclaw";

const SERVICE_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;
const REF_ID_PATTERN = /^[A-Za-z0-9._/-]{1,256}$/;

type KeyringConfig = {
  source: typeof SOURCE_ID;
  service?: string;
  keychainPath?: string;
};

function assertSafeArgValue(label: string, value: string, pattern: RegExp): void {
  if (!pattern.test(value)) {
    throw new Error(`keyring provider: ${label} "${value}" must match ${pattern.source}.`);
  }
  if (value.startsWith("-")) {
    throw new Error(`keyring provider: ${label} "${value}" must not start with "-".`);
  }
}

function assertSafeKeychainPath(value: string): void {
  if (value.startsWith("-")) {
    throw new Error(`keyring provider: keychainPath "${value}" must not start with "-".`);
  }
  if (!path.isAbsolute(value)) {
    throw new Error(`keyring provider: keychainPath "${value}" must be an absolute path.`);
  }
  if (!value.endsWith(".keychain-db") && !value.endsWith(".keychain")) {
    throw new Error(
      `keyring provider: keychainPath "${value}" must end with ".keychain-db" or ".keychain".`,
    );
  }
}

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

type ResolutionFailure =
  | { kind: "tool_missing"; cause: unknown }
  | { kind: "not_found"; cause: unknown };

function classifyLinuxError(err: unknown): ResolutionFailure {
  const msg = err instanceof Error ? err.message : String(err);
  if (
    msg.includes("ENOENT") ||
    msg.includes("not found") ||
    msg.toLowerCase().includes("command not found") ||
    msg.toLowerCase().includes("no such file")
  ) {
    return { kind: "tool_missing", cause: err };
  }
  return { kind: "not_found", cause: err };
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
      throw new Error(
        `Keyring secret "${params.refId}" not found in libsecret (provider: ${params.providerName}, service: ${params.service}). Use \`secret-tool store\` to add it.`,
      );
    }
    return value;
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("Keyring secret ")) {
      throw err;
    }
    const failure = classifyLinuxError(err);
    if (failure.kind === "tool_missing") {
      throw new Error(
        `Keyring provider requires the libsecret \`secret-tool\` CLI on Linux but it was not found on PATH. Install libsecret-tools (Debian/Ubuntu) or libsecret (Fedora/Arch) and try again.`,
        { cause: failure.cause },
      );
    }
    throw new Error(
      `Keyring secret "${params.refId}" lookup failed (provider: ${params.providerName}, service: ${params.service}): ${err instanceof Error ? err.message : String(err)}`,
      { cause: failure.cause },
    );
  }
}

export function createKeyringSecretProvider(): SecretProviderPlugin {
  return {
    id: SOURCE_ID,
    label: "OS Keyring",
    validateConfig(cfg) {
      if (typeof cfg !== "object" || cfg === null) {
        throw new Error('keyring provider: config must be an object with source "keyring".');
      }
      const c = cfg as Partial<KeyringConfig>;
      if (c.source !== SOURCE_ID) {
        throw new Error(`keyring provider: config.source must be "${SOURCE_ID}".`);
      }
      if (c.service !== undefined) {
        if (typeof c.service !== "string") {
          throw new Error("keyring provider: config.service must be a string when set.");
        }
        assertSafeArgValue("service", c.service, SERVICE_PATTERN);
      }
      if (c.keychainPath !== undefined) {
        if (typeof c.keychainPath !== "string") {
          throw new Error("keyring provider: config.keychainPath must be a string when set.");
        }
        assertSafeKeychainPath(c.keychainPath);
      }
    },
    async resolve(ctx) {
      const cfg = ctx.providerConfig as KeyringConfig;
      const service = cfg.service ?? DEFAULT_SERVICE;
      assertSafeArgValue("service", service, SERVICE_PATTERN);
      for (const ref of ctx.refs) {
        assertSafeArgValue("ref id", ref.id, REF_ID_PATTERN);
      }

      const os = platform();
      const out = new Map<string, unknown>();

      if (os === "darwin") {
        const keychainPath =
          cfg.keychainPath ?? path.join(homedir(), "Library", "Keychains", "openclaw.keychain-db");
        assertSafeKeychainPath(keychainPath);
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
