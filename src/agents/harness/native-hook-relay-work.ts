import { drainNativeHookRelayBridge } from "./native-hook-relay-bridge.js";
import type { NativeHookRelayBridgeRegistration } from "./native-hook-relay-types.js";

/** Preserve the first failure while joining work admitted during a pending drain. */
export async function drainNativeHookRelayWork(params: {
  bridge: NativeHookRelayBridgeRegistration;
  readRenewal: () => Promise<void>;
}): Promise<void> {
  let renewal: Promise<void>;
  let failure: { error: unknown } | undefined;
  do {
    renewal = params.readRenewal();
    try {
      await renewal;
    } catch (error) {
      failure ??= { error };
    }
    try {
      await drainNativeHookRelayBridge(params.bridge);
    } catch (error) {
      failure ??= { error };
    }
  } while (renewal !== params.readRenewal());
  if (failure) {
    throw failure.error;
  }
}
