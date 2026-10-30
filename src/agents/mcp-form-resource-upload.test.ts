import { beforeEach, describe, expect, it, vi } from "vitest";
import { prepareMcpAppFormUpload } from "./mcp-form-resource-upload.js";
import type { McpAppFormOrigin } from "./mcp-ui-resource.js";
const mocks = vi.hoisted(() => ({ provider: vi.fn() }));
vi.mock("../gateway/mcp-app-form-resources.js", () => ({
  createMcpAppWorkspaceUploadProvider: mocks.provider,
}));
beforeEach(() => {
  vi.resetAllMocks();
  mocks.provider.mockImplementation((options) => options);
});
function origin(local: () => boolean) {
  return {
    runtime: { workspaceDir: "/workspace", canReadLocalFiles: local },
    serverName: "demo",
    agentId: "main",
    sessionKey: "agent:main:app",
    assertCurrent: vi.fn(),
  } as unknown as McpAppFormOrigin;
}
describe("transport-owned form uploads", () => {
  it("does not advertise file URIs to non-local transports", async () => {
    expect(await prepareMcpAppFormUpload(origin(() => false))).toBeUndefined();
    expect(mocks.provider).not.toHaveBeenCalled();
  });
  it("retains the transport and requester authority checks for the actual upload", async () => {
    let local = true;
    const source = origin(() => local);
    await prepareMcpAppFormUpload(source);
    const options = mocks.provider.mock.calls[0]![0];
    expect(options).toMatchObject({
      workspaceDir: "/workspace",
      agentId: "main",
      sessionKey: "agent:main:app",
    });
    local = false;
    expect(options.assertCurrent).toThrow("transport changed");
    expect(source.assertCurrent).toHaveBeenCalled();
  });
});
