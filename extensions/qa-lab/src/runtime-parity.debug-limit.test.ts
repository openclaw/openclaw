// Qa Lab tests bound runtime parity mock debug reads.
import { describe, expect, it, vi } from "vitest";

const fetchWithSsrFGuardMock = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  fetchWithSsrFGuard: fetchWithSsrFGuardMock,
}));

import { __testing } from "./runtime-parity.js";

describe("runtime parity mock debug response limit", () => {
  it("stops reading an oversized debug request snapshot", async () => {
    const chunkSize = 512 * 1024;
    let reads = 0;
    let canceled = false;
    const release = vi.fn(async () => {});
    fetchWithSsrFGuardMock.mockResolvedValueOnce({
      response: new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            reads += 1;
            controller.enqueue(new Uint8Array(chunkSize));
          },
          cancel() {
            canceled = true;
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
      release,
    });

    const toolCalls = await __testing.loadRuntimeParityMockToolCalls(
      "http://127.0.0.1:49152",
      "parent prompt",
      ["parent prompt"],
    );

    expect(toolCalls).toBeNull();
    expect(reads).toBeLessThanOrEqual(3);
    expect(canceled).toBe(true);
    expect(release).toHaveBeenCalledOnce();
  });
});