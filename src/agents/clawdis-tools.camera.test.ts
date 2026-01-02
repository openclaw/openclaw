import { beforeEach, describe, expect, it, vi } from "vitest";

const callGateway = vi.fn();

vi.mock("../gateway/call.js", () => ({ callGateway }));
vi.mock("../media/image-ops.js", () => ({
  getImageMetadata: vi.fn(async () => ({ width: 1, height: 1 })),
  resizeToJpeg: vi.fn(async () => Buffer.from("jpeg")),
}));

import { createClawdisTools } from "./clawdis-tools.js";

describe("clawdis_nodes camera_snap", () => {
  beforeEach(() => {
    callGateway.mockReset();
  });

  it("maps jpg payloads to image/jpeg", async () => {
    callGateway.mockImplementation(async ({ method }) => {
      if (method === "node.list") {
        return { nodes: [{ nodeId: "mac-1" }] };
      }
      if (method === "node.invoke") {
        return {
          payload: {
            format: "jpg",
            base64: "aGVsbG8=",
            width: 1,
            height: 1,
          },
        };
      }
      throw new Error(`unexpected method: ${String(method)}`);
    });

    const tool = createClawdisTools().find(
      (candidate) => candidate.name === "clawdis_nodes",
    );
    if (!tool) throw new Error("missing clawdis_nodes tool");

    const result = await tool.execute("call1", {
      action: "camera_snap",
      node: "mac-1",
      facing: "front",
    });

    const images = (result.content ?? []).filter(
      (block) => block.type === "image",
    );
    expect(images).toHaveLength(1);
    expect(images[0]?.mimeType).toBe("image/jpeg");
  });
});
