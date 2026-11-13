import {
  createRemoteShellSandboxSession,
  type RemoteShellCommandSpec,
  type SandboxBackendCommandResult,
} from "openclaw/plugin-sdk/sandbox";

export type Invoke = (
  args: string[],
  options?: { stdin?: Buffer | string; signal?: AbortSignal },
) => Promise<SandboxBackendCommandResult>;

/** One launcher/environment boundary for captured commands and deferred exec. */
export function buildNativeCommandSpec(args: string[]): RemoteShellCommandSpec {
  return {
    argv: ["/usr/local/gcp/bin/sandbox", ...args],
    env: { PATH: "/usr/local/gcp/bin:/usr/bin:/bin" },
  };
}

export const invoke: Invoke = async (args, options = {}) => {
  const session = createRemoteShellSandboxSession({
    buildCommand: () => buildNativeCommandSpec(args),
  });
  return await session.runCommand({ remoteCommand: "", allowFailure: true, ...options });
};
