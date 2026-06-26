// File Transfer tests cover dir list tool plugin behavior.
import {
  callGatewayTool,
  listNodes,
  resolveNodeIdFromList,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDirListTool } from "./dir-list-tool.js";

vi.mock("openclaw/plugin-sdk/agent-harness-runtime", () => ({
  callGatewayTool: vi.fn(),
  listNodes: vi.fn(),
  resolveNodeIdFromList: vi.fn(),
}));

vi.mock("../shared/audit.js", () => ({
  appendFileTransferAudit: vi.fn(),
}));

afterEach(() => {
  vi.mocked(callGatewayTool).mockReset();
  vi.mocked(listNodes).mockReset();
  vi.mocked(resolveNodeIdFromList).mockReset();
});

describe("dir_list tool", () => {
  it("summarizes files and subdirectories from returned entries", async () => {
    vi.mocked(listNodes).mockResolvedValue([
      {
        nodeId: "node-1",
        displayName: "Studio Mac",
      },
    ]);
    vi.mocked(resolveNodeIdFromList).mockReturnValue("node-1");
    vi.mocked(callGatewayTool).mockResolvedValue({
      payload: {
        path: "/tmp/project",
        entries: [{ isDir: false }, { isDir: true }, { isDir: false }],
      },
    });

    const result = await createDirListTool().execute("tool-call-1", {
      node: "Studio Mac",
      path: "/tmp/project",
    });

    expect(result.content).toEqual([
      {
        type: "text",
        text: "Listed /tmp/project: 2 files, 1 subdir",
      },
    ]);
  });

  it("reports missing paired nodes before retrying guessed local node names", async () => {
    vi.mocked(listNodes).mockResolvedValue([]);

    await expect(
      createDirListTool().execute("tool-call-1", {
        node: "local",
        path: "/tmp/project",
      }),
    ).rejects.toThrow(
      "no paired nodes available; file-transfer tools require a paired node from nodes status. Use local file/exec tools for local workspace paths.",
    );

    expect(resolveNodeIdFromList).not.toHaveBeenCalled();
    expect(callGatewayTool).not.toHaveBeenCalled();
  });

  it("describes node as a paired-node reference, not a local alias", () => {
    const schema = JSON.stringify(createDirListTool().parameters);

    expect(schema).toContain("Existing paired node id");
    expect(schema).toContain("nodes status");
    expect(schema).toContain("local, host, gateway, or auto");
  });
});
