import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db.js";
import {
  withOpenClawStateLeaseAsync,
  type OpenClawStateAsyncLeaseContext,
} from "../state/openclaw-state-lease.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";

const MCP_LIFECYCLE_LEASE_SCOPE = "core:claw-mcp-lifecycle";
const MCP_LIFECYCLE_LEASE_MS = 5 * 60_000;
const MCP_LIFECYCLE_WAIT_MS = 10 * 60_000;

type McpLifecycleLeaseOptions = Pick<OpenClawStateDatabaseOptions, "env" | "path">;

/** Serialize ownership decisions and global config mutations for one MCP server. */
export async function withMcpLifecycleLease<T>(
  name: string,
  options: McpLifecycleLeaseOptions,
  run: (lease: OpenClawStateAsyncLeaseContext) => Promise<T>,
): Promise<T> {
  return await withOpenClawStateLeaseAsync(
    {
      scope: MCP_LIFECYCLE_LEASE_SCOPE,
      key: name.trim(),
      leaseMs: MCP_LIFECYCLE_LEASE_MS,
      waitMs: MCP_LIFECYCLE_WAIT_MS,
      leaseLabel: "Template MCP lifecycle lease",
      operationLabel: "templates.mcp.lifecycle.lease",
    },
    captureOpenClawStateWorkerContext(options),
    run,
  );
}
