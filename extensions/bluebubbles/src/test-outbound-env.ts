import { vi } from "vitest";
import { BLUEBUBBLES_OUTBOUND_ENABLED_ENV } from "./types.js";

export async function withBlueBubblesOutboundEnabled<T>(
  run: () => Promise<T> | T,
): Promise<T> {
  vi.stubEnv(BLUEBUBBLES_OUTBOUND_ENABLED_ENV, "1");
  try {
    return await run();
  } finally {
    vi.unstubAllEnvs();
  }
}

export function restoreBlueBubblesOutboundEnv(): void {
  vi.unstubAllEnvs();
}
