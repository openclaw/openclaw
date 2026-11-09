import { randomUUID } from "node:crypto";
import { parseScreenSnapshotResult } from "openclaw/plugin-sdk/computer-use";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { AUDIO_COMMAND, boundedNumber, object, parseAudio } from "./audio.js";

type Request = Parameters<Parameters<OpenClawPluginApi["registerGatewayMethod"]>[1]>[0];
type Nodes = OpenClawPluginApi["runtime"]["nodes"];

function text(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 512) {
    throw new Error(`${name} must be a nonempty string of at most 512 characters`);
  }
  return value;
}

function integer(value: unknown, min: number, max: number): number {
  const result = boundedNumber(value, min, max);
  if (!Number.isInteger(result)) {
    throw new Error("Expected an integer");
  }
  return result;
}

function parsePointer(value: unknown) {
  const input = object(value, [
    "nodeId",
    "operation",
    "screenIndex",
    "referenceWidth",
    "referenceHeight",
    "x",
    "y",
    "scrollDirection",
    "scrollAmount",
  ]);
  const nodeId = text(input.nodeId, "nodeId");
  const referenceWidth = integer(input.referenceWidth, 1, 32_768);
  const referenceHeight = integer(input.referenceHeight, 1, 32_768);
  const target = {
    screenIndex: integer(input.screenIndex, 0, 15),
    refWidth: Math.max(referenceWidth, referenceHeight),
  };
  if (input.operation === "move") {
    if (input.scrollDirection !== undefined || input.scrollAmount !== undefined) {
      throw new Error("Move does not accept scrolling parameters");
    }
    return {
      nodeId,
      referenceWidth,
      referenceHeight,
      params: {
        ...target,
        action: "mouse_move",
        x: boundedNumber(input.x, 0, referenceWidth - 1),
        y: boundedNumber(input.y, 0, referenceHeight - 1),
      },
    };
  }
  if (
    input.operation !== "scroll" ||
    !["up", "down", "left", "right"].includes(String(input.scrollDirection))
  ) {
    throw new Error("Only bounded move and scroll operations are supported");
  }
  return {
    nodeId,
    referenceWidth,
    referenceHeight,
    params: {
      ...target,
      action: "scroll",
      x: boundedNumber(input.x, 0, referenceWidth - 1),
      y: boundedNumber(input.y, 0, referenceHeight - 1),
      scrollDirection: input.scrollDirection,
      scrollAmount: integer(input.scrollAmount, 1, 10),
    },
  };
}

/** Gateway RPCs retain caller authority through dispatch; no target discovery fallback. */
export function registerDeviceGateway(api: OpenClawPluginApi) {
  let pointerBusy = false;
  let lastPointerAt = 0;
  const nodes: Nodes = api.runtime.nodes;
  const register = (
    method: string,
    handle: (request: Request, assertCurrent: () => void) => Promise<unknown>,
  ) => {
    api.registerGatewayMethod(
      method,
      async (request) => {
        const assertCurrent = () => {
          request.signal?.throwIfAborted();
          request.assertHandlerCurrent?.();
          request.sessionAccessAuthority?.assertCurrent();
          request.sessionMutationAuthorization?.assertCurrent();
          request.sessionMutationCommitGuard?.();
          if (request.hasCurrentClientAuthority?.() === false) {
            throw new Error("Caller disconnected");
          }
        };
        try {
          assertCurrent();
          const result = await handle(request, assertCurrent);
          assertCurrent();
          request.respond(true, result);
        } catch (error) {
          request.respond(false, undefined, {
            code: "DEVICE_CONTROL_FAILED",
            message: error instanceof Error ? error.message : "Device control failed",
          });
        }
      },
      { scope: "operator.write" },
    );
  };
  const target = async (nodeId: string, command: string, assertCurrent: () => void) => {
    const result = await nodes.list({ connected: true });
    assertCurrent();
    const node = result.nodes.find((entry) => entry.nodeId === nodeId);
    if (!node?.connected || !node.invocableCommands?.includes(command)) {
      throw new Error("The selected node is unavailable or this command is not explicitly allowed");
    }
  };
  for (const operation of ["play", "stop"] as const) {
    register(
      operation === "play" ? "device-controls.audio" : "device-controls.audio-stop",
      async (request, assertCurrent) => {
        const input = object(
          request.params,
          operation === "play"
            ? ["nodeId", "operationId", "notes", "volume"]
            : ["nodeId", "operationId"],
        );
        const { nodeId: rawNodeId, ...payload } = input;
        const nodeId = text(rawNodeId, "nodeId");
        const params = parseAudio({ ...payload, operation });
        await target(nodeId, AUDIO_COMMAND, assertCurrent);
        return nodes.invoke({
          nodeId,
          command: AUDIO_COMMAND,
          params,
          timeoutMs: 15_000,
          signal: request.signal,
          assertCurrent,
          sessionKey: request.sessionAccessAuthority?.target.sessionKey,
        });
      },
    );
  }
  register("device-controls.pointer", async (request, assertCurrent) => {
    const { nodeId, params, referenceWidth, referenceHeight } = parsePointer(request.params);
    if (pointerBusy || Date.now() - lastPointerAt < 50) {
      throw new Error("Pointer input is busy; coalesce input instead of queuing it");
    }
    pointerBusy = true;
    const executionId = randomUUID();
    let dispatched = false;
    try {
      await target(nodeId, "computer.act", assertCurrent);
      await target(nodeId, "screen.snapshot", assertCurrent);
      lastPointerAt = Date.now();
      dispatched = true;
      const captured = await nodes.invoke({
        nodeId,
        command: "screen.snapshot",
        params: {
          executionId,
          executionTimeoutMs: 15_000,
          screenIndex: params.screenIndex,
          maxWidth: params.refWidth,
          format: "png",
        },
        timeoutMs: 5_000,
        signal: request.signal,
        assertCurrent,
        sessionKey: request.sessionAccessAuthority?.target.sessionKey,
      });
      assertCurrent();
      if (!isRecord(captured) || captured.ok !== true) {
        throw new Error("The selected screen could not be observed; no pointer input was sent");
      }
      const screen = parseScreenSnapshotResult(
        captured.payload ??
          (typeof captured.payloadJSON === "string" ? JSON.parse(captured.payloadJSON) : undefined),
      );
      if (
        screen.screenIndex !== params.screenIndex ||
        screen.width !== referenceWidth ||
        screen.height !== referenceHeight ||
        !screen.displayFrameId
      ) {
        throw new Error("The approved screen dimensions changed; approve a new display binding");
      }
      // Keep the captured pixels inside this invocation. The input and snapshot
      // must share the native execution: CUA frame references are execution-owned.
      return await nodes.invoke({
        nodeId,
        command: "computer.act",
        params: {
          ...params,
          executionId,
          requireExistingExecution: true,
          displayFrameId: screen.displayFrameId,
        },
        timeoutMs: 3_000,
        signal: request.signal,
        assertCurrent,
        sessionKey: request.sessionAccessAuthority?.target.sessionKey,
      });
    } finally {
      try {
        // Close only our exact execution while caller authority remains valid.
        // The native opt-in deadline also retires it if revocation blocks this RPC.
        if (dispatched) {
          await nodes.invoke({
            nodeId,
            command: "computer.act",
            params: { action: "__close_execution", executionId },
            timeoutMs: 3_000,
          });
        }
      } finally {
        pointerBusy = false;
      }
    }
  });
}
