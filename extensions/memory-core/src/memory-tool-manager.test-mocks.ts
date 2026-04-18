// Memory Core plugin module implements memory tool manager mock behavior.
import type { MemorySearchRuntimeDebug } from "openclaw/plugin-sdk/memory-core-host-runtime-files";
import { vi } from "vitest";

export type SearchImplOptions = {
  maxResults?: number;
  minScore?: number;
  sessionKey?: string;
  qmdSearchModeOverride?: "query" | "search" | "vsearch" | string;
  onDebug?: (debug: MemorySearchRuntimeDebug | unknown) => void;
  signal?: AbortSignal;
};
export type SearchImpl = (opts?: SearchImplOptions) => Promise<unknown[]>;
export type MemoryReadParams = { relPath: string; from?: number; lines?: number };
export type MemoryReadResult = {
  text: string;
  path: string;
  truncated?: boolean;
  from?: number;
  lines?: number;
  nextFrom?: number;
};
type MemoryBackend = "builtin" | "qmd" | "mem0" | "hybrid";

let backend: MemoryBackend = "builtin";
let workspaceDir = "/workspace";
let customStatus: Record<string, unknown> | undefined;
let searchImpl: SearchImpl = async () => [];
let getManagerImpl:
  | ((params: { cfg?: unknown; agentId?: string; purpose?: string }) => Promise<{
      manager?: unknown;
      error?: string;
    }>)
  | undefined;
let readFileImpl: (params: MemoryReadParams) => Promise<MemoryReadResult> = async (params) => ({
  text: "",
  path: params.relPath,
  from: params.from ?? 1,
  lines: params.lines ?? 120,
});

const stubManager = {
  search: vi.fn(async (arg1?: unknown, arg2?: SearchImplOptions) => {
    const opts =
      typeof arg1 === "string" || arg1 === undefined ? arg2 : (arg1 as SearchImplOptions);
    return await searchImpl(opts);
  }),
  readFile: vi.fn(async (params: MemoryReadParams) => await readFileImpl(params)),
  status: () => ({
    backend,
    files: 1,
    chunks: 1,
    dirty: false,
    workspaceDir,
    dbPath: `${workspaceDir}/.memory/index.sqlite`,
    provider: "builtin",
    model: "builtin",
    requestedProvider: "builtin",
    sources: ["memory" as const],
    sourceCounts: [{ source: "memory" as const, files: 1, chunks: 1 }],
    custom: customStatus,
  }),
  sync: vi.fn(),
  probeVectorAvailability: vi.fn(async () => true),
  close: vi.fn(),
};

const getMemorySearchManagerMock = vi.fn(
  async (params: { cfg?: unknown; agentId?: string; purpose?: string }) =>
    getManagerImpl ? await getManagerImpl(params) : { manager: stubManager },
);
const readAgentMemoryFileMock = vi.fn(
  async (params: MemoryReadParams) => await readFileImpl(params),
);

const { memoryIndexModuleId, memoryToolsRuntimeModuleId } = vi.hoisted(() => ({
  memoryIndexModuleId: "./memory/index.js",
  memoryToolsRuntimeModuleId: "./tools.runtime.js",
}));

vi.mock(memoryIndexModuleId, () => ({
  getMemorySearchManager: getMemorySearchManagerMock,
}));

vi.mock(memoryToolsRuntimeModuleId, () => ({
  resolveMemoryBackendConfig: ({
    cfg,
  }: {
    cfg?: { memory?: { backend?: string; qmd?: unknown } };
  }) => ({
    backend,
    qmd: cfg?.memory?.qmd,
  }),
  getMemorySearchManager: getMemorySearchManagerMock,
  readAgentMemoryFile: readAgentMemoryFileMock,
}));

export function setMemoryBackend(next: MemoryBackend): void {
  backend = next;
}

export function setMemoryWorkspaceDir(next: string): void {
  workspaceDir = next;
}

export function setMemoryCustomStatus(next: Record<string, unknown> | undefined): void {
  customStatus = next;
}

export function setMemorySearchImpl(next: SearchImpl): void {
  searchImpl = next;
}

export function setMemorySearchManagerImpl(
  next: (params: { cfg?: unknown; agentId?: string; purpose?: string }) => Promise<{
    manager?: unknown;
    error?: string;
  }>,
): void {
  getManagerImpl = next;
}

export function setMemoryReadFileImpl(
  next: (params: MemoryReadParams) => Promise<MemoryReadResult>,
): void {
  readFileImpl = next;
}

export function resetMemoryToolMockState(overrides?: {
  backend?: MemoryBackend;
  searchImpl?: SearchImpl;
  readFileImpl?: (params: MemoryReadParams) => Promise<MemoryReadResult>;
}): void {
  backend = overrides?.backend ?? "builtin";
  workspaceDir = "/workspace";
  customStatus = undefined;
  getManagerImpl = undefined;
  searchImpl = overrides?.searchImpl ?? (async () => []);
  readFileImpl =
    overrides?.readFileImpl ??
    (async (params: MemoryReadParams) => ({
      text: "",
      path: params.relPath,
      from: params.from ?? 1,
      lines: params.lines ?? 120,
    }));
  vi.clearAllMocks();
}

export function getMemorySearchManagerMockCalls(): number {
  return getMemorySearchManagerMock.mock.calls.length;
}

export function getMemorySyncMockCalls(): number {
  return stubManager.sync.mock.calls.length;
}

export function getMemoryCloseMockCalls(): number {
  return stubManager.close.mock.calls.length;
}

export function getMemorySearchManagerMockConfigs(): unknown[] {
  return getMemorySearchManagerMock.mock.calls.map(([params]) => params.cfg);
}

export function getMemorySearchManagerMockParams(): Array<{
  cfg?: unknown;
  agentId?: string;
  purpose?: string;
}> {
  return getMemorySearchManagerMock.mock.calls.map(([params]) => params);
}

export function getReadAgentMemoryFileMockCalls(): number {
  return readAgentMemoryFileMock.mock.calls.length;
}
