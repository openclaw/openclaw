// Shared Knowledge test fixtures: a host-like plugin API whose Knowledge state
// root holds a real registry, vaults adopted into it the way conversion does,
// and per-test cleanup that runs before temporary directories are removed.
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach } from "vitest";
import { featurePrincipal, pinPrincipal, type Partition, type VaultAccess } from "./access.js";
import { sdkUrls } from "./storage-client.js";
import { StoreRegistry } from "./store-registry.js";

type Cleanup = () => unknown;
const pendingCleanups: Cleanup[] = [];

/** Run `cleanup` after the current test, in registration order, before its temp dirs are removed. */
export function afterTest(cleanup: Cleanup): void {
  pendingCleanups.push(cleanup);
}

/** Host service registration that stops the service after the current test, so its
 * storage and registry worker threads never outlive the test that started them. */
export function stopAtTestEnd(service: { stop?: () => unknown }): void {
  afterTest(() => service.stop?.());
}

/** Install per-test cleanup for a suite: deferred `afterTest` work first, then temp-dir removal. */
export function useTestTempDirs() {
  return useAutoCleanupTempDirTracker((removeDirs) =>
    afterEach(async () => {
      // Every cleanup runs even when an earlier one fails; the first failure is reported.
      const failures: unknown[] = [];
      for (const cleanup of pendingCleanups.splice(0)) {
        try {
          await cleanup();
        } catch (error) {
          failures.push(error);
        }
      }
      removeDirs();
      if (failures.length) {
        throw failures[0];
      }
    }),
  );
}

/** A test store configuration: the registry row plus the plugin-wide test gates. */
export type TestStoreConfig = {
  root: string;
  statePath: string;
  vaultId: string;
  publicationId: string;
  writesEnabled: boolean;
  operatorRead?: boolean;
};

/** Create a store vault (v2 manifest, private partition) under `base`. */
export async function createVault(
  base: string,
  { name = "vault", writesEnabled = true }: { name?: string; writesEnabled?: boolean } = {},
) {
  const root = path.join(base, name);
  await mkdir(path.join(root, "private"), { recursive: true });
  const manifest = {
    format: "knowledge-vault-v2",
    vaultId: randomUUID(),
    generation: 0,
    publicationId: randomUUID(),
  };
  await writeFile(path.join(root, "vault.json"), JSON.stringify(manifest));
  const config: TestStoreConfig = {
    root,
    statePath: path.join(base, `${name}.sqlite`),
    vaultId: manifest.vaultId,
    publicationId: manifest.publicationId,
    writesEnabled,
  };
  return { root, manifest, config };
}

/** Register an existing store under a logical binding in the state root's registry. */
export function adopt(
  stateRoot: string,
  binding: string,
  config: Pick<TestStoreConfig, "vaultId" | "publicationId" | "root" | "statePath">,
  label?: string,
): void {
  const registry = new StoreRegistry(stateRoot);
  try {
    registry.adopt(
      binding,
      {
        vaultId: config.vaultId,
        publicationId: config.publicationId,
        root: config.root,
        statePath: config.statePath,
      },
      label,
    );
  } finally {
    registry.close();
  }
}

/** Options for a host-like plugin API. */
export type HostApiOptions = {
  agents?: string[];
  stores?: Record<string, unknown>;
  policy?: Record<string, unknown>;
  lag?: boolean;
  extra?: Record<string, unknown>;
  binding?: string;
  name?: string;
  writesEnabled?: boolean;
};

// The host configuration shape the fixture API exposes through config.current().
type HostConfig = {
  agents: { list: { id: string; default?: boolean }[] };
  plugins: { entries: { knowledge: { config: Record<string, unknown> } } };
};

/** A plugin API with host config, state dir and config mutation. `host.config`
 * is live: tests may edit it to simulate external configuration edits. */
export function hostApi(
  base: string,
  { agents = ["main"], stores = {}, policy = {}, lag = false, extra = {} }: HostApiOptions = {},
) {
  const stateDir = path.join(base, "state");
  const host: { config: HostConfig; pending?: HostConfig } = {
    config: {
      agents: { list: agents.map((id, i) => ({ id, ...(i === 0 ? { default: true } : {}) })) },
      plugins: { entries: { knowledge: { config: { ...policy, stores } } } },
    },
  };
  const writes: HostConfig[] = [];
  const api = {
    id: "knowledge",
    runtimeSource: fileURLToPath(new URL("../index.ts", import.meta.url)),
    pluginConfig: { ...policy },
    registerService: stopAtTestEnd,
    runtime: {
      state: { resolveStateDir: () => stateDir },
      agent: {
        resolveAgentIdentity: (_cfg: unknown, id: string) => ({
          name: id[0]!.toUpperCase() + id.slice(1),
        }),
      },
      config: {
        current: () => host.config,
        async mutateConfigFile({
          mutate,
          writeOptions,
        }: {
          mutate: (draft: HostConfig, context: unknown) => unknown;
          writeOptions?: { assertCurrent?: () => void };
        }) {
          // Mutations start from the persisted file, which may be ahead of config.current().
          const draft = structuredClone(host.pending ?? host.config);
          await mutate(draft, { snapshot: {}, previousHash: null });
          // Real hosts check caller authority at publication.
          writeOptions?.assertCurrent?.();
          writes.push(draft);
          // Real hosts publish a write to config.current() after it resolves.
          if (lag) {
            host.pending = draft;
          } else {
            host.config = draft;
          }
          return { nextConfig: draft, persistedHash: String(writes.length) };
        },
      },
    },
    ...extra,
  } as unknown as OpenClawPluginApi;
  return {
    api,
    host,
    writes,
    stateDir,
    stateRoot: path.join(stateDir, "knowledge"),
    /** Publish a lagged write, as the host eventually does. */
    publish() {
      if (host.pending) {
        host.config = host.pending;
        host.pending = undefined;
      }
    },
  };
}

/** Session-action registration through the current host's grouped session controls. */
export const sessionActions = (register: (action: any) => unknown = () => {}) => ({
  session: { controls: { registerSessionAction: register } },
});

/** A host memory audience as minted for tool invocations. */
export type TestAudience = { kind: string; agentId?: string; [key: string]: unknown };

// Invocation contexts stay loosely typed: tests reshape authority mid-test and
// deliberately pass contexts the host would never mint.
/** Owner-direct tool context for an agent. */
export const toolContext = (
  api: OpenClawPluginApi,
  agentId = "main",
  audience: TestAudience = { kind: "owner-private", agentId },
): any => ({
  source: "tool" as const,
  api,
  tool: {
    agentId,
    memoryAudience: audience,
    assertInvocationCurrent() {},
    assertMemoryAudienceCurrent() {},
  },
});

/** Operator session-action context. */
export const operatorContext = (
  api: OpenClawPluginApi,
  scopes = ["operator.write"],
  assertCurrent = () => {},
): any => ({
  source: "session-action" as const,
  api,
  action: { client: { connId: "test", scopes, assertCurrent } },
});

/** Pinned access for direct storage calls, from a feature context. */
export function accessFor(context: unknown, write = false, operatorAgent = "main"): VaultAccess {
  const pinned = pinPrincipal(
    featurePrincipal(
      context as Parameters<typeof featurePrincipal>[0],
      true,
      write,
      operatorAgent,
      () => undefined,
    ),
  );
  return { ...pinned.principal, assertCurrent: () => pinned.assertSame() };
}

/** Plain access for storage-level tests that do not exercise authority. */
export const plainAccess = (
  scope: Partition = { visibility: "private" },
  agentId = "main",
): VaultAccess => ({ scope, agentId, assertCurrent() {} });

/** One-call fixture: a vault adopted as `agent:main` plus a host API. */
export async function storeFixture(base: string, options: HostApiOptions = {}) {
  const vault = await createVault(base, options);
  const host = hostApi(base, options);
  adopt(host.stateRoot, options.binding ?? "agent:main", vault.config);
  return { ...vault, ...host };
}

/** Host API for a test-created vault: adopts it as `agent:main` and takes the
 * plugin-wide gates from the vault config's legacy-named test fields. */
export function apiFor(base: string, config: TestStoreConfig, options: HostApiOptions = {}) {
  const host = hostApi(base, {
    ...options,
    policy: {
      operatorRead: config.operatorRead ?? true,
      writesEnabled: config.writesEnabled ?? false,
      ...options.policy,
    },
  });
  adopt(host.stateRoot, options.binding ?? "agent:main", config);
  return host.api;
}

/** URL of a Knowledge source module, importable by a child started with `childEvalArgs`. */
export const sourceModule = (name: string) => new URL(`./${name}.ts`, import.meta.url).href;

/** Node arguments that evaluate `source` in a real child process with this runtime's
 * TypeScript loader and the SDK modules the test resolved. `source` must load
 * Knowledge modules with dynamic `import()` so the resolver hook is installed first. */
export function childEvalArgs(source: string): string[] {
  // Keep only the loader and export conditions; drop runner-specific preloads.
  const loader: string[] = [];
  process.execArgv.forEach((arg, i) => {
    const value = process.execArgv[i + 1] ?? "";
    if (arg === "--conditions") {
      loader.push(arg, value);
    } else if (arg === "--import" && value.includes("/tsx/")) {
      loader.push(arg, value);
    }
  });
  const hooks = `import { registerHooks } from "node:module";
    const sdk = ${JSON.stringify(sdkUrls())};
    registerHooks({ resolve(specifier, context, next) {
      const url = sdk[specifier];
      return url ? { url, shortCircuit: true } : next(specifier, context);
    } });`;
  return [...loader, "--input-type=module", "--eval", `${hooks}\n${source}`];
}

/** Comparator matching `Array#sort()` without one: ascending UTF-16 order of `String(value)`. */
export function defaultOrder(left: unknown, right: unknown): number {
  const a = String(left),
    b = String(right);
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Serialize to JSON text and parse it back, as a host transport does. */
export function jsonRoundTrip<T>(value: T): T {
  const text = JSON.stringify(value);
  return JSON.parse(text) as T;
}
