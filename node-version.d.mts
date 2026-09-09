export type NodeReleaseVersion = {
  major: number;
  minor: number;
  patch: number;
};

export function parseNodeReleaseVersion(value: unknown): NodeReleaseVersion | null;
export function isNodeVersionAtLeast(
  version: NodeReleaseVersion | null,
  minimum: NodeReleaseVersion,
): boolean;
export function isSupportedOpenClawNodeVersion(value: unknown): boolean;
export const PROCESS_NODE_VERSION_CHECK: string;

export const SUPPORTED_NODE_VERSIONS: string;
export function formatUnsupportedNodeVersionMessage(version: string | null): string;
export function formatUnsupportedNodeDiagnosticWarning(version: string | null): string;
export function classifyUnsupportedNodeCommand(
  argv: readonly string[],
): "diagnostic" | "update" | null;
export function canRunOpenClawNodeDiagnostics(value: unknown, hasNodeSqlite: boolean): boolean;
