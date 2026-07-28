import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";

export const managedSignalCredentialValues = {
  signalTransportKind: "managed-native",
  signalCliPath: "/opt/openclaw/signal-cli",
  signalCliConfigPath: "/var/lib/signal-cli",
};

export function toCredentialValues(
  values: Partial<Record<string, string>> | undefined,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(values ?? {}).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

export function configuredManagedSignalConfig(options?: {
  withTransport?: boolean;
}): OpenClawConfig {
  return {
    channels: {
      signal: {
        accounts: {
          work: {
            account: "+15555550123",
            accountUuid: "123e4567-e89b-12d3-a456-426614174000",
            ...(options?.withTransport === false
              ? {}
              : {
                  transport: {
                    kind: "managed-native",
                    cliPath: "/opt/openclaw/signal-cli",
                    configPath: "/var/lib/signal-cli",
                    httpHost: "127.0.0.1",
                    httpPort: 8080,
                  },
                }),
          },
        },
      },
    },
  };
}
