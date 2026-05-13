export type VirtualAgentFsEntryKind = "directory" | "file";

const VIRTUAL_AGENT_FS_ENTRY_KINDS = new Set<VirtualAgentFsEntryKind>(["directory", "file"]);

export function parseVirtualAgentFsEntryKind(value: unknown): VirtualAgentFsEntryKind {
  if (
    typeof value === "string" &&
    VIRTUAL_AGENT_FS_ENTRY_KINDS.has(value as VirtualAgentFsEntryKind)
  ) {
    return value as VirtualAgentFsEntryKind;
  }
  throw new Error(`Invalid persisted VFS entry kind: ${JSON.stringify(value)}`);
}

export type VirtualAgentFsEntry = {
  path: string;
  kind: VirtualAgentFsEntryKind;
  size: number;
  metadata: Record<string, unknown>;
  updatedAt: number;
};

export type VirtualAgentFsWriteOptions = {
  metadata?: Record<string, unknown>;
};

export type VirtualAgentFsRemoveOptions = {
  recursive?: boolean;
};

export type VirtualAgentFsListOptions = {
  recursive?: boolean;
};

export type VirtualAgentFsExportEntry = VirtualAgentFsEntry & {
  contentBase64?: string;
};

export type VirtualAgentFs = {
  stat(path: string): VirtualAgentFsEntry | null;
  readFile(path: string): Buffer;
  writeFile(path: string, content: Buffer | string, options?: VirtualAgentFsWriteOptions): void;
  mkdir(path: string, options?: VirtualAgentFsWriteOptions): void;
  readdir(path: string): VirtualAgentFsEntry[];
  list(path?: string, options?: VirtualAgentFsListOptions): VirtualAgentFsEntry[];
  export(path?: string, options?: VirtualAgentFsListOptions): VirtualAgentFsExportEntry[];
  remove(path: string, options?: VirtualAgentFsRemoveOptions): void;
  rename(fromPath: string, toPath: string): void;
};

export type HostCapabilityFs = {
  root: string;
};

export type AgentToolArtifact = {
  agentId: string;
  runId: string;
  artifactId: string;
  kind: string;
  metadata: Record<string, unknown>;
  size: number;
  createdAt: number;
};

export type AgentToolArtifactExport = AgentToolArtifact & {
  blobBase64?: string;
};

export type AgentToolArtifactWriteOptions = {
  artifactId?: string;
  kind: string;
  metadata?: Record<string, unknown>;
  blob?: Buffer | string;
};

export type AgentToolArtifactStore = {
  write(options: AgentToolArtifactWriteOptions): AgentToolArtifact;
  list(): AgentToolArtifact[];
  read(artifactId: string): AgentToolArtifactExport | null;
  export(): AgentToolArtifactExport[];
  deleteAll(): number;
};

export type AgentRunArtifact = {
  agentId: string;
  runId: string;
  path: string;
  kind: string;
  metadata: Record<string, unknown>;
  size: number;
  createdAt: number;
};

export type AgentRunArtifactExport = AgentRunArtifact & {
  blobBase64?: string;
};

export type AgentRunArtifactWriteOptions = {
  path: string;
  kind: string;
  metadata?: Record<string, unknown>;
  blob?: Buffer | string;
};

export type AgentRunArtifactStore = {
  write(options: AgentRunArtifactWriteOptions): AgentRunArtifact;
  list(prefix?: string): AgentRunArtifact[];
  read(path: string): AgentRunArtifactExport | null;
  export(prefix?: string): AgentRunArtifactExport[];
  deleteAll(): number;
};

export type AgentFilesystem = {
  scratch: VirtualAgentFs;
  artifacts?: AgentToolArtifactStore;
  runArtifacts?: AgentRunArtifactStore;
  workspace?: HostCapabilityFs;
};
