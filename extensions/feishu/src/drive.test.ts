import fsSync from "fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./accounts.js", () => ({
  listEnabledFeishuAccounts: vi.fn().mockReturnValue([{ id: "main", configured: true }]),
}));

vi.mock("./tool-account.js", () => ({
  resolveAnyEnabledFeishuToolsConfig: vi.fn().mockReturnValue({ drive: true }),
  createFeishuToolClient: vi.fn(),
}));

import { registerFeishuDriveTools } from "./drive.js";
import { createFeishuToolClient } from "./tool-account.js";

function buildMockClient(overrides: Record<string, unknown> = {}) {
  return {
    domain: "https://open.feishu.cn",
    httpInstance: {
      get: vi.fn().mockResolvedValue({ code: 0, data: { token: "root_token" } }),
    },
    drive: {
      file: {
        list: vi.fn().mockResolvedValue({ code: 0, data: { files: [] } }),
        createFolder: vi.fn().mockResolvedValue({ code: 0, data: { token: "new_folder" } }),
        move: vi.fn().mockResolvedValue({ code: 0, data: { task_id: "t1" } }),
        delete: vi.fn().mockResolvedValue({ code: 0, data: { task_id: "t2" } }),
      },
      media: {
        uploadAll: vi.fn().mockResolvedValue({ file_token: "uploaded_token_123" }),
      },
    },
    ...overrides,
  };
}

describe("feishu_drive upload action", () => {
  let executeTool: (params: Record<string, unknown>) => Promise<unknown>;
  let mockClient: ReturnType<typeof buildMockClient>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockClient = buildMockClient();
    vi.mocked(createFeishuToolClient).mockReturnValue(mockClient as any);

    const tools: { execute: typeof executeTool }[] = [];
    const mockApi = {
      config: { channels: { feishu: {} } },
      logger: { debug: vi.fn(), info: vi.fn() },
      registerTool: (factory: (ctx: any) => any, _opts: any) => {
        const tool = factory({ agentAccountId: "main" });
        tools.push(tool);
      },
    };

    registerFeishuDriveTools(mockApi as any);
    executeTool = (params) => tools[0].execute("call_1", params);
  });

  async function createTmpFile(
    name = "test.pdf",
    content = "file-content",
  ): Promise<{ dir: string; file: string }> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-drive-test-"));
    const file = path.join(dir, name);
    await fs.writeFile(file, content);
    return { dir, file };
  }

  it("uploads a local file to root folder", async () => {
    const { dir, file } = await createTmpFile();
    try {
      const result = (await executeTool({ action: "upload", file_path: file })) as any;
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.file_token).toBe("uploaded_token_123");
      expect(parsed.name).toBe("test.pdf");
      expect(parsed.size).toBe(Buffer.from("file-content").length);

      expect(mockClient.drive.media.uploadAll).toHaveBeenCalledWith({
        data: expect.objectContaining({
          file_name: "test.pdf",
          parent_type: "explorer",
          parent_node: "root_token",
          size: Buffer.from("file-content").length,
        }),
      });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("uploads to a specific folder_token", async () => {
    const { dir, file } = await createTmpFile();
    try {
      await executeTool({
        action: "upload",
        file_path: file,
        folder_token: "fldcnTarget",
      });

      expect(mockClient.drive.media.uploadAll).toHaveBeenCalledWith({
        data: expect.objectContaining({
          parent_node: "fldcnTarget",
        }),
      });
      // Should not call root folder API when explicit folder_token given
      expect(mockClient.httpInstance.get).not.toHaveBeenCalled();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("uses custom file_name override", async () => {
    const { dir, file } = await createTmpFile();
    try {
      const result = (await executeTool({
        action: "upload",
        file_path: file,
        file_name: "report-2026.pdf",
      })) as any;
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.name).toBe("report-2026.pdf");
      expect(mockClient.drive.media.uploadAll).toHaveBeenCalledWith({
        data: expect.objectContaining({ file_name: "report-2026.pdf" }),
      });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("returns error for non-existent file", async () => {
    const result = (await executeTool({
      action: "upload",
      file_path: "/tmp/does-not-exist-abc123.txt",
    })) as any;
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.error).toMatch(/File not found/);
    expect(mockClient.drive.media.uploadAll).not.toHaveBeenCalled();
  });

  it("returns error for directory path", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-drive-dir-"));
    try {
      const result = (await executeTool({
        action: "upload",
        file_path: dir,
      })) as any;
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.error).toMatch(/Not a file/);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("returns error when file exceeds 20MB", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-drive-big-"));
    const file = path.join(dir, "big.bin");
    // Create a sparse file that reports > 20MB
    const fd = fsSync.openSync(file, "w");
    fsSync.ftruncateSync(fd, 21 * 1024 * 1024);
    fsSync.closeSync(fd);
    try {
      const result = (await executeTool({
        action: "upload",
        file_path: file,
      })) as any;
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.error).toMatch(/File too large/);
      expect(parsed.error).toMatch(/20MB/);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
