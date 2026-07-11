// Memory Core receives local-service acquisition from the host before provider creation.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";

type ModelProviderConfig = NonNullable<NonNullable<OpenClawConfig["models"]>["providers"]>[string];

export type MemoryCoreAcquireLocalService = (
  target: {
    providerId: string;
    baseUrl: string;
    headers?: HeadersInit;
    service?: ModelProviderConfig["localService"];
  },
  signal?: AbortSignal | null,
) => Promise<{ release: () => Promise<void> } | undefined>;

let acquireLocalService: MemoryCoreAcquireLocalService | undefined;

export function configureMemoryCoreEmbeddingLocalService(
  acquire: MemoryCoreAcquireLocalService | undefined,
): void {
  acquireLocalService = acquire;
}

export function getMemoryCoreEmbeddingLocalService(): MemoryCoreAcquireLocalService | undefined {
  return acquireLocalService;
}
