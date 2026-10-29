import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";

export type RegisteredSessionCatalogProvider = Parameters<
  OpenClawPluginApi["registerSessionCatalog"]
>[0];
type OptionalCatalogAgent<T extends { agentId?: string }> = Omit<T, "agentId"> & {
  agentId?: string;
};
export type SessionCatalogProvider = Omit<
  RegisteredSessionCatalogProvider,
  "list" | "read" | "continueSession" | "archive" | "openTerminal"
> & {
  list: (
    params: OptionalCatalogAgent<Parameters<RegisteredSessionCatalogProvider["list"]>[0]>,
  ) => ReturnType<RegisteredSessionCatalogProvider["list"]>;
  read: (
    params: OptionalCatalogAgent<Parameters<RegisteredSessionCatalogProvider["read"]>[0]>,
  ) => ReturnType<RegisteredSessionCatalogProvider["read"]>;
  continueSession?: (
    params: OptionalCatalogAgent<
      Parameters<NonNullable<RegisteredSessionCatalogProvider["continueSession"]>>[0]
    >,
  ) => ReturnType<NonNullable<RegisteredSessionCatalogProvider["continueSession"]>>;
  archive?: (
    params: OptionalCatalogAgent<
      Parameters<NonNullable<RegisteredSessionCatalogProvider["archive"]>>[0]
    >,
  ) => ReturnType<NonNullable<RegisteredSessionCatalogProvider["archive"]>>;
  openTerminal?: (
    params: OptionalCatalogAgent<
      Parameters<NonNullable<RegisteredSessionCatalogProvider["openTerminal"]>>[0]
    >,
  ) => ReturnType<NonNullable<RegisteredSessionCatalogProvider["openTerminal"]>>;
};
export function bindTestCatalogOwner(
  provider: RegisteredSessionCatalogProvider,
): SessionCatalogProvider {
  return {
    ...provider,
    list: (params) => provider.list({ agentId: "main", ...params }),
    read: (params) => provider.read({ agentId: "main", ...params }),
    ...(provider.continueSession
      ? {
          continueSession: (params) => provider.continueSession!({ agentId: "main", ...params }),
        }
      : {}),
    ...(provider.archive
      ? { archive: (params) => provider.archive!({ agentId: "main", ...params }) }
      : {}),
    ...(provider.openTerminal
      ? {
          openTerminal: (params) => provider.openTerminal!({ agentId: "main", ...params }),
        }
      : {}),
  } as SessionCatalogProvider;
}
