import { beforeEach, describe, expect, it, vi } from "vitest";

const createFeishuToolClientMock = vi.hoisted(() => vi.fn());
const resolveAnyEnabledMock = vi.hoisted(() => vi.fn());

vi.mock("./tool-account.js", () => ({
  createFeishuToolClient: createFeishuToolClientMock,
  resolveAnyEnabledFeishuToolsConfig: resolveAnyEnabledMock,
}));

vi.mock("./accounts.js", () => ({
  listEnabledFeishuAccounts: () => [{ id: "default", config: {} }],
}));

import { registerFeishuDriveTools } from "./drive.js";

describe("feishu_drive upload and import", () => {
  const fileUploadAllMock = vi.fn();
  const importTaskCreateMock = vi.fn();
  const importTaskGetMock = vi.fn();
  const fileListMock = vi.fn();

  function getFeishuDriveTool() {
    const registerTool = vi.fn();
    registerFeishuDriveTools({
      config: {
        channels: {
          feishu: { appId: "app_id", appSecret: "app_secret" },
        },
      },
      logger: { debug: vi.fn(), info: vi.fn() },
      registerTool,
    } as any);

    const tool = registerTool.mock.calls
      .map((call: any) => call[0])
      .map((t: any) => (typeof t === "function" ? t({}) : t))
      .find((t: any) => t.name === "feishu_drive");
    expect(tool).toBeDefined();
    return tool;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    resolveAnyEnabledMock.mockReturnValue({ drive: true });
    createFeishuToolClientMock.mockReturnValue({
      drive: {
        file: {
          list: fileListMock,
          uploadAll: fileUploadAllMock,
          createFolder: vi.fn().mockResolvedValue({ code: 0, data: {} }),
          move: vi.fn().mockResolvedValue({ code: 0, data: {} }),
          delete: vi.fn().mockResolvedValue({ code: 0, data: {} }),
        },
        importTask: {
          create: importTaskCreateMock,
          get: importTaskGetMock,
        },
      },
    });
  });

  it("upload: uploads text content as a file", async () => {
    fileUploadAllMock.mockResolvedValue({ file_token: "box_uploaded_123" });
    const tool = getFeishuDriveTool();
    const result = await tool.execute("call-1", {
      action: "upload",
      file_name: "test.md",
      content: "# Hello",
      folder_token: "fld_abc",
    });
    expect(result.details.file_token).toBe("box_uploaded_123");
    expect(fileUploadAllMock).toHaveBeenCalledWith({
      data: expect.objectContaining({
        file_name: "test.md",
        parent_type: "explorer",
        parent_node: "fld_abc",
      }),
    });
  });

  it("import: imports uploaded file as Feishu document", async () => {
    importTaskCreateMock.mockResolvedValue({
      code: 0,
      data: { ticket: "ticket_abc" },
    });
    importTaskGetMock.mockResolvedValue({
      data: {
        result: {
          job_status: 0,
          token: "docx_imported",
          url: "https://feishu.cn/docx/docx_imported",
          type: "docx",
        },
      },
    });

    const tool = getFeishuDriveTool();
    const result = await tool.execute("call-2", {
      action: "import",
      file_token: "box_uploaded_123",
      file_extension: "md",
      target_type: "docx",
      folder_token: "fld_abc",
    });
    expect(result.details.token).toBe("docx_imported");
    expect(result.details.type).toBe("docx");
  });

  it("import: throws on task creation failure", async () => {
    importTaskCreateMock.mockResolvedValue({
      code: 1770006,
      msg: "schema mismatch",
    });

    const tool = getFeishuDriveTool();
    const result = await tool.execute("call-3", {
      action: "import",
      file_token: "box_bad",
      file_extension: "md",
      target_type: "docx",
      folder_token: "fld_abc",
    });
    expect(result.details.error).toContain("schema mismatch");
  });

  it("import: throws on job failure status", async () => {
    importTaskCreateMock.mockResolvedValue({
      code: 0,
      data: { ticket: "ticket_fail" },
    });
    importTaskGetMock.mockResolvedValue({
      data: {
        result: {
          job_status: 2,
          job_error_msg: "unsupported format",
        },
      },
    });

    const tool = getFeishuDriveTool();
    const result = await tool.execute("call-4", {
      action: "import",
      file_token: "box_bad_fmt",
      file_extension: "xyz",
      target_type: "docx",
      folder_token: "fld_abc",
    });
    expect(result.details.error).toContain("unsupported format");
  });
});
