import type { Client } from "@buape/carbon";
import { getDiscordGatewayEmitter } from "../monitor.gateway.js";

export type EarlyGatewayErrorGuard = {
  pendingErrors: unknown[];
  release: () => void;
};

export function attachEarlyGatewayErrorGuard(client: Client): EarlyGatewayErrorGuard {
  const pendingErrors: unknown[] = [];
  const gateway = client.getPlugin("gateway");
  const emitter = getDiscordGatewayEmitter(gateway);
  if (!emitter) {
    return {
      pendingErrors,
      release: () => {},
    };
  }

  let released = false;
  const onGatewayError = (err: unknown) => {
    pendingErrors.push(err);
  };
  emitter.on("error", onGatewayError);

  return {
    pendingErrors,
    release: () => {
      if (released) {
        return;
      }
      released = true;
      emitter.removeListener("error", onGatewayError);
    },
  };
}
