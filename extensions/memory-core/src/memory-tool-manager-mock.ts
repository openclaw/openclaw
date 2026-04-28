import type { MemorySearchRuntimeDebug } from "openclaw/plugin-sdk/memory-core-host-runtime-files";
import { vi } from "vitest";

export type SearchImpl = (opts?: {
  maxResults?: number;
  minScore?: number;
  sessionKey?: string;
  qmdSearchModeOverride?: "query" | "search" | "vsearch";
  onDebug?: (debug: MemorySearchRuntimeDebug) => void;
  sources?: Array<"memory" | "sessions">;
}) => Promise<unknown[]>;
export type MemoryReadParams = { relPath: string; from?: number; lines?: number };
export type MemoryReadResult = {
  text: string;
  path: string;
  truncated?: boolean;
  from?: number;
  lines?: number;
  nextFrom?: number;
};
type MemoryBackend = "builtin" | "qmd";

let backend: MemoryBackend = "builtin";
let workspaceDir = "/workspace";
let customStatus: Record<string, unknown> | undefined;
let searchImpl: SearchImpl = async () => [];
let searchImplByAgent = new Map<string, SearchImpl>();
let readFileImpl: (params: MemoryReadParams) => Promise<MemoryReadResult> = async (params) => ({
  text: "",
  path: params.relPath,
  from: params.from ?? 1,
  lines: params.lines ?? 120,
});

function createStubManager(agentId: string) {
  return {
    search: vi.fn(
      async (_query: string, opts?: Parameters<SearchImpl>[0]) =>
        await (searchImplByAgent.get(agentId) ?? searchImpl)(opts),
    ),
    readFile: vi.fn(async (params: MemoryReadParams) => await readFileImpl(params)),
    status: () => ({
      backend,
      files: 1,
      chunks: 1,
      dirty: false,
      workspaceDir,
      dbPath: `/workspace/.memory/${agentId}.sqlite`,
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
}

const stubManager = createStubManager("main");

const getMemorySearchManagerMock = vi.fn(async (params: { cfg?: unknown; agentId?: string }) => ({
  manager: params.agentId ? createStubManager(params.agentId) : stubManager,
}));
const readAgentMemoryFileMock = vi.fn(
  async (params: MemoryReadParams) => await readFileImpl(params),
);

vi.mock("./tools.runtime.js", () => ({
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

export function setMemoryStatusCustom(next: Record<string, unknown> | undefined): void {
  customStatus = next;
}

export function setMemorySearchImpl(next: SearchImpl): void {
  searchImpl = next;
}

export function setMemorySearchImplForAgent(agentId: string, next: SearchImpl): void {
  searchImplByAgent.set(agentId, next);
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
  searchImpl = overrides?.searchImpl ?? (async () => []);
  searchImplByAgent = new Map<string, SearchImpl>();
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

export function getMemorySearchManagerMockConfigs(): unknown[] {
  return getMemorySearchManagerMock.mock.calls.map(([params]) => params.cfg);
}

export function getMemorySearchManagerMockAgentIds(): Array<string | undefined> {
  return getMemorySearchManagerMock.mock.calls.map(([params]) => params.agentId);
}

export function getReadAgentMemoryFileMockCalls(): number {
  return readAgentMemoryFileMock.mock.calls.length;
}
