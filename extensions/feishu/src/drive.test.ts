import { beforeEach, describe, expect, it, vi } from "vitest";

const createFeishuClientMock = vi.hoisted(() => vi.fn());

vi.mock("./client.js", () => ({
  createFeishuClient: createFeishuClientMock,
}));

import { registerFeishuDriveTools } from "./drive.js";

const fileListMock = vi.hoisted(() => vi.fn());
const fileCreateFolderMock = vi.hoisted(() => vi.fn());
const fileMoveMock = vi.hoisted(() => vi.fn());
const fileDeleteMock = vi.hoisted(() => vi.fn());
const fileUploadAllMock = vi.hoisted(() => vi.fn());
const importTaskCreateMock = vi.hoisted(() => vi.fn());
const importTaskGetMock = vi.hoisted(() => vi.fn());

function setupMocks() {
  createFeishuClientMock.mockReturnValue({
    drive: {
      file: {
        list: fileListMock,
        createFolder: fileCreateFolderMock,
        move: fileMoveMock,
        delete: fileDeleteMock,
        uploadAll: fileUploadAllMock,
      },
      importTask: {
        create: importTaskCreateMock,
        get: importTaskGetMock,
      },
    },
  });

  fileListMock.mockResolvedValue({
    code: 0,
    data: { files: [], next_page_token: undefined },
  });

  fileCreateFolderMock.mockResolvedValue({
    code: 0,
    data: { token: "fld_new", url: "https://feishu.cn/drive/folder/fld_new" },
  });

  fileUploadAllMock.mockResolvedValue({ file_token: "box_uploaded_123" });

  importTaskCreateMock.mockResolvedValue({
    code: 0,
    data: { ticket: "ticket_abc" },
  });

  importTaskGetMock.mockResolvedValue({
    code: 0,
    data: {
      result: {
        job_status: 0,
        token: "doc_imported_456",
        url: "https://feishu.cn/docx/doc_imported_456",
        type: "docx",
      },
    },
  });
}

function getFeishuDriveTool() {
  const registerTool = vi.fn();
  registerFeishuDriveTools({
    config: {
      channels: {
        feishu: { appId: "app_id", appSecret: "app_secret" },
      },
    } as any,
    logger: { debug: vi.fn(), info: vi.fn() } as any,
    registerTool,
  } as any);

  return registerTool.mock.calls
    .map((call) => call[0])
    .map((tool) => (typeof tool === "function" ? tool({}) : tool))
    .find((tool) => tool.name === "feishu_drive");
}

describe("feishu_drive upload action", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupMocks();
  });

  it("uploads text content as a file", async () => {
    const tool = getFeishuDriveTool();
    expect(tool).toBeDefined();

    const result = await tool.execute("call-1", {
      action: "upload",
      file_name: "report.md",
      content: "# Report\n\nHello world",
      folder_token: "fld_target",
    });

    expect(fileUploadAllMock).toHaveBeenCalledTimes(1);
    const callArgs = fileUploadAllMock.mock.calls[0][0];
    expect(callArgs.data.file_name).toBe("report.md");
    expect(callArgs.data.parent_type).toBe("explorer");
    expect(callArgs.data.parent_node).toBe("fld_target");
    expect(result.details.file_token).toBe("box_uploaded_123");
  });
});

describe("feishu_drive import action", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupMocks();
  });

  it("imports an uploaded file as Feishu document", async () => {
    const tool = getFeishuDriveTool();
    expect(tool).toBeDefined();

    const result = await tool.execute("call-2", {
      action: "import",
      file_token: "box_uploaded_123",
      file_extension: "md",
      target_type: "docx",
      folder_token: "fld_target",
    });

    expect(importTaskCreateMock).toHaveBeenCalledTimes(1);
    const createArgs = importTaskCreateMock.mock.calls[0][0];
    expect(createArgs.data.file_token).toBe("box_uploaded_123");
    expect(createArgs.data.file_extension).toBe("md");
    expect(createArgs.data.type).toBe("docx");
    expect(createArgs.data.point.mount_key).toBe("fld_target");

    expect(result.details.token).toBe("doc_imported_456");
    expect(result.details.type).toBe("docx");
  });

  it("returns error when import task creation fails", async () => {
    importTaskCreateMock.mockResolvedValueOnce({
      code: 99999,
      msg: "Permission denied",
    });

    const tool = getFeishuDriveTool();
    const result = await tool.execute("call-3", {
      action: "import",
      file_token: "box_bad",
      file_extension: "md",
      target_type: "docx",
      folder_token: "fld_target",
    });

    expect(result.details.error).toContain("Permission denied");
  });

  it("returns error when import job fails", async () => {
    importTaskGetMock.mockResolvedValueOnce({
      code: 0,
      data: {
        result: {
          job_status: 2,
          job_error_msg: "Unsupported format",
        },
      },
    });

    const tool = getFeishuDriveTool();
    const result = await tool.execute("call-4", {
      action: "import",
      file_token: "box_bad_fmt",
      file_extension: "xyz",
      target_type: "docx",
      folder_token: "fld_target",
    });

    expect(result.details.error).toContain("Unsupported format");
  });
});
