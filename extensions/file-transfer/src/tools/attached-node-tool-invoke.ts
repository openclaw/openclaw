import crypto from "node:crypto";
import { callGatewayTool } from "openclaw/plugin-sdk/agent-harness-runtime";
import { NODE_COMPUTER_RESOURCE_FETCH_COMMAND } from "openclaw/plugin-sdk/plugin-entry";
import type { invokeNodeToolPayload } from "./node-tool-invoke.js";

type Receipt = { environmentId: string; ownerEpoch: number; generation: number };
type Connection = { nodeId: string; connectionId: string };
type Reply = {
  connection: Connection;
  ok: boolean;
  payload?: unknown;
  payloadJSON?: string | null;
  error?: { message?: string } | null;
  nodeId: string;
  attachment: Receipt;
};
export async function invokeAttachedFileTool(
  input: Parameters<typeof invokeNodeToolPayload>[0],
  environmentId: string,
) {
  if (input.params.gatewayUrl !== undefined || input.params.gatewayToken !== undefined) {
    throw new Error("Attached files must use this Gateway's current conversation authority");
  }
  const options = {
    timeoutMs: typeof input.params.timeoutMs === "number" ? input.params.timeoutMs : undefined,
  };
  const resourceHandle = input.params.resourceHandle;
  if (
    resourceHandle !== undefined &&
    (input.command !== "file.fetch" || typeof resourceHandle !== "string" || !resourceHandle.trim())
  ) {
    throw new Error("Resource handles require an attached file_fetch request");
  }
  const raw = await callGatewayTool<Reply>(
    "environments.session.invoke",
    options,
    {
      environmentId,
      command: resourceHandle ? NODE_COMPUTER_RESOURCE_FETCH_COMMAND : input.command,
      params: resourceHandle
        ? { resourceHandle, maxBytes: input.commandParams.maxBytes }
        : input.commandParams,
      timeoutMs: options.timeoutMs,
      idempotencyKey: crypto.randomUUID(),
    },
    input.assertDispatchCurrent
      ? {
          dispatchAuthority: {
            version: 2,
            kind: "source-bound",
            assertCurrent: input.assertDispatchCurrent,
          },
        }
      : undefined,
  );
  if (!raw.ok) {
    throw new Error(raw.error?.message ?? "Attached file capability failed");
  }
  const expected = raw.attachment;
  const assertCurrent = async () => {
    input.assertDispatchCurrent?.();
    const status = await callGatewayTool<{
      attachment: Receipt | null;
      closed?: boolean;
      connection?: Connection;
    }>("environments.session.status", options, { environmentId });
    input.assertDispatchCurrent?.();
    const current = status.attachment;
    if (
      !current ||
      status.closed ||
      !raw.connection ||
      status.connection?.nodeId !== raw.connection.nodeId ||
      status.connection?.connectionId !== raw.connection.connectionId ||
      current.environmentId !== expected.environmentId ||
      current.ownerEpoch !== expected.ownerEpoch ||
      current.generation !== expected.generation
    ) {
      throw new Error("Attached file owner changed before publication");
    }
  };
  await assertCurrent();
  return {
    raw: { payload: raw.payload ?? (raw.payloadJSON ? JSON.parse(raw.payloadJSON) : undefined) },
    nodeId: raw.nodeId,
    nodeDisplayName: environmentId,
    assertCurrent,
  };
}
