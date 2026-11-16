import type { MemoryPluginCapability } from "openclaw/plugin-sdk/memory-host-core";

/** Provider-neutral memory runtime derived from the public memory capability contract. */
export type MemoryProviderRuntime = NonNullable<MemoryPluginCapability["providerRuntime"]>;
type MemoryProviderOpenResult = Awaited<ReturnType<MemoryProviderRuntime["open"]>>;
type MemoryProviderHandle = NonNullable<MemoryProviderOpenResult["provider"]>;
type MemorySearchPage = Awaited<ReturnType<MemoryProviderHandle["search"]>>;

/** Trusted caller context supplied when the host opens a provider lease. */
export type MemoryCallerContext = Parameters<MemoryProviderRuntime["open"]>[0]["context"];
/** Provider-scoped reference accepted by Knowledge record reads. */
export type MemoryReference = Parameters<MemoryProviderHandle["get"]>[0]["reference"];
/** Search request accepted by the provider-neutral Knowledge runtime. */
export type MemorySearchRequest = Parameters<MemoryProviderHandle["search"]>[0];
/** Citation returned by a provider-neutral Knowledge read. */
export type MemoryCitation = NonNullable<MemorySearchPage["hits"][number]["citations"]>[number];
