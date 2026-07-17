// Signal test support owns cleanup for process-global plugin runtime state.
import type {
  ChannelIngressDrain,
  ChannelIngressQueue,
} from "openclaw/plugin-sdk/channel-outbound";
import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";
import type { SignalSseEvent } from "./client-adapter.js";
import "./signal-ingress.js";

export type SignalIngressPayload = {
  version: 1;
  receivedAt: number;
  event: SignalSseEvent;
};

type SignalIngressEnqueueResult =
  | Awaited<ReturnType<ChannelIngressQueue<SignalIngressPayload>["enqueue"]>>
  | { kind: "ignored" };

type SignalIngressTestApi = {
  createSignalIngressDrain(params: {
    queue: ChannelIngressQueue<SignalIngressPayload>;
    dispatch: (
      event: SignalSseEvent,
      lifecycle: {
        abortSignal: AbortSignal;
        onAdopted: () => void | Promise<void>;
        onDeferred: () => void;
        onAdoptionFinalizing: () => void;
        onAbandoned: () => void;
      },
    ) => unknown;
  }): ChannelIngressDrain;
  enqueueSignalIngressEvent(params: {
    queue: ChannelIngressQueue<SignalIngressPayload>;
    event: SignalSseEvent;
    now?: number;
  }): Promise<SignalIngressEnqueueResult>;
  resolveSignalIngressEventId(event: SignalSseEvent): string | null;
  resolveSignalIngressLaneKey(event: SignalSseEvent): string | null;
};

export const signalIngressTesting = (globalThis as Record<PropertyKey, unknown>)[
  Symbol.for("openclaw.signalIngressTestApi")
] as SignalIngressTestApi;

const { clearRuntime } = createPluginRuntimeStore<PluginRuntime>({
  pluginId: "signal",
  errorMessage: "Signal runtime not initialized",
});

export function clearSignalRuntimeForTest(): void {
  clearRuntime();
}
