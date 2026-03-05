/**
 * Integration tests for the 6 AI tools registered by findoo-backtest-plugin (v1.1).
 *
 * We mock BacktestClient + packStrategy + validateStrategy + pollUntilDone
 * and test each tool's execute() path including error handling.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Mock modules ──

const mockClient = {
  submit: vi.fn(),
  getTask: vi.fn(),
  getReport: vi.fn(),
  listTasks: vi.fn(),
  cancelTask: vi.fn(),
  health: vi.fn(),
};

vi.mock("./backtest-client.js", () => {
  return {
    BacktestClient: class MockBacktestClient {
      constructor() {
        return mockClient;
      }
    },
  };
});

vi.mock("./poller.js", () => ({
  pollUntilDone: vi.fn(),
}));

vi.mock("./strategy-packer.js", () => ({
  packStrategy: vi.fn(),
}));

vi.mock("./strategy-validator.js", () => ({
  validateStrategy: vi.fn(),
}));

vi.mock("./config.js", () => ({
  resolveConfig: vi.fn(() => ({
    backtestApiUrl: "http://localhost:8000",
    backtestApiKey: "",
    pollIntervalMs: 100,
    pollTimeoutMs: 5000,
    requestTimeoutMs: 5000,
  })),
}));

import { pollUntilDone } from "./poller.js";
import { packStrategy } from "./strategy-packer.js";
import { validateStrategy } from "./strategy-validator.js";
import type { RemoteReport, RemoteTask } from "./types.js";

// ── Capture registered tools ──

type ToolEntry = {
  name: string;
  execute: (toolCallId: string, params: Record<string, unknown>) => Promise<unknown>;
};

const registeredTools = new Map<string, ToolEntry>();
const registeredServices: Record<string, unknown>[] = [];

function makeFakeApi() {
  registeredTools.clear();
  registeredServices.length = 0;
  return {
    pluginConfig: {},
    registerTool: vi.fn((def: ToolEntry, _opts?: unknown) => {
      registeredTools.set(def.name, def);
    }),
    registerService: vi.fn((svc: Record<string, unknown>) => {
      registeredServices.push(svc);
    }),
  };
}

async function loadPlugin() {
  const mod = await import("../index.js");
  return mod.default;
}

function getToolExecute(name: string) {
  const tool = registeredTools.get(name);
  if (!tool) throw new Error(`Tool "${name}" not registered`);
  return tool.execute;
}

function parseResult(result: unknown): Record<string, unknown> {
  const r = result as { content: { text: string }[] };
  return JSON.parse(r.content[0].text);
}

// ── Test fixtures (v1.1 format) ──

function makeTask(status: string): RemoteTask {
  return {
    task_id: "t-1",
    status: status as RemoteTask["status"],
    created_at: "2024-01-01T00:00:00Z",
  };
}

const MOCK_REPORT: RemoteReport = {
  task_id: "t-1",
  performance: {
    totalReturn: 15.0,
    sharpe: 1.2,
    maxDrawdown: 8.0,
    totalTrades: 42,
  },
  alpha: null,
  equity_curve: null,
  trade_journal: null,
};

// ── Tests ──

describe("findoo-backtest-plugin tools (v1.1)", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const plugin = await loadPlugin();
    const api = makeFakeApi();
    await plugin.register(api as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("fin_backtest_remote_submit", () => {
    it("validates, packs, uploads and polls for completion (wait=true)", async () => {
      vi.mocked(validateStrategy).mockResolvedValue({ valid: true, errors: [], warnings: [] });
      vi.mocked(packStrategy).mockResolvedValue(Buffer.from("fake-zip"));
      mockClient.submit.mockResolvedValue({
        task_id: "t-1",
        status: "submitted",
        message: "ok",
      });
      vi.mocked(pollUntilDone).mockResolvedValue({
        task: makeTask("completed"),
        report: MOCK_REPORT,
      });

      const exec = getToolExecute("fin_backtest_remote_submit");
      const result = parseResult(
        await exec("call-1", {
          strategy_path: "/tmp/strat",
          engine: "script",
        }),
      );

      expect(result.success).toBe(true);
      expect(result.sharpe).toBeDefined();
      expect(result.total_trades).toBe(42);
      expect(validateStrategy).toHaveBeenCalledWith("/tmp/strat");
      expect(packStrategy).toHaveBeenCalledWith("/tmp/strat");
      expect(mockClient.submit).toHaveBeenCalledTimes(1);
      expect(pollUntilDone).toHaveBeenCalledTimes(1);
    });

    it("submits async when wait=false", async () => {
      vi.mocked(validateStrategy).mockResolvedValue({ valid: true, errors: [], warnings: [] });
      vi.mocked(packStrategy).mockResolvedValue(Buffer.from("zip"));
      mockClient.submit.mockResolvedValue({
        task_id: "t-1",
        status: "submitted",
      });

      const exec = getToolExecute("fin_backtest_remote_submit");
      const result = parseResult(
        await exec("call-2", {
          strategy_path: "/tmp/strat",
          engine: "agent",
          wait: false,
        }),
      );

      expect(result.success).toBe(true);
      expect(result.task_id).toBe("t-1");
      expect(pollUntilDone).not.toHaveBeenCalled();
    });

    it("returns error on failure", async () => {
      vi.mocked(validateStrategy).mockResolvedValue({ valid: true, errors: [], warnings: [] });
      vi.mocked(packStrategy).mockResolvedValue(Buffer.from("zip"));
      mockClient.submit.mockRejectedValue(new Error("Network error"));

      const exec = getToolExecute("fin_backtest_remote_submit");
      const result = parseResult(
        await exec("call-3", {
          strategy_path: "/tmp/strat",
        }),
      );

      expect(result.error).toBe("Network error");
    });

    it("fails fast on validation errors", async () => {
      vi.mocked(validateStrategy).mockResolvedValue({
        valid: false,
        errors: [{ level: "error", category: "structure", message: "Missing fep.yaml" }],
        warnings: [],
      });

      const exec = getToolExecute("fin_backtest_remote_submit");
      const result = parseResult(await exec("call-4", { strategy_path: "/tmp/bad" }));

      expect(result.success).toBe(false);
      expect(result.message).toContain("Compliance check failed");
      expect(packStrategy).not.toHaveBeenCalled();
    });

    it("handles completed poll with no report", async () => {
      vi.mocked(validateStrategy).mockResolvedValue({ valid: true, errors: [], warnings: [] });
      vi.mocked(packStrategy).mockResolvedValue(Buffer.from("zip"));
      mockClient.submit.mockResolvedValue({ task_id: "t-1", status: "submitted" });
      vi.mocked(pollUntilDone).mockResolvedValue({
        task: makeTask("completed"),
        report: undefined,
      });

      const exec = getToolExecute("fin_backtest_remote_submit");
      const result = parseResult(
        await exec("call-5", {
          strategy_path: "/tmp/strat",
          engine: "script",
        }),
      );

      expect(result.success).toBe(true);
      expect(result.message).toContain("no report");
    });
  });

  describe("fin_backtest_remote_status", () => {
    it("returns task status", async () => {
      mockClient.getTask.mockResolvedValue(makeTask("processing"));

      const exec = getToolExecute("fin_backtest_remote_status");
      const result = parseResult(await exec("call-1", { task_id: "t-1" }));

      expect(result.status).toBe("processing");
    });

    it("includes report when requested and completed", async () => {
      mockClient.getTask.mockResolvedValue(makeTask("completed"));
      mockClient.getReport.mockResolvedValue(MOCK_REPORT);

      const exec = getToolExecute("fin_backtest_remote_status");
      const result = parseResult(await exec("call-2", { task_id: "t-1", include_report: true }));

      expect(result.report_summary).toBeDefined();
      expect(mockClient.getReport).toHaveBeenCalledTimes(1);
    });

    it("does not fetch report if not completed", async () => {
      mockClient.getTask.mockResolvedValue(makeTask("processing"));

      const exec = getToolExecute("fin_backtest_remote_status");
      await exec("call-3", { task_id: "t-1", include_report: true });

      expect(mockClient.getReport).not.toHaveBeenCalled();
    });
  });

  describe("fin_backtest_remote_list", () => {
    it("lists tasks with pagination", async () => {
      mockClient.listTasks.mockResolvedValue({
        tasks: [makeTask("completed"), makeTask("processing")],
        total: 10,
        limit: 2,
        offset: 0,
      });

      const exec = getToolExecute("fin_backtest_remote_list");
      const result = parseResult(await exec("call-1", { limit: 2, offset: 0 }));

      expect(result.success).toBe(true);
      expect(result.total).toBe(10);
      expect(result.showing).toBe(2);
    });
  });

  describe("fin_backtest_remote_cancel", () => {
    it("cancels a task via DELETE", async () => {
      mockClient.cancelTask.mockResolvedValue({ task_id: "t-1", status: "failed" });

      const exec = getToolExecute("fin_backtest_remote_cancel");
      const result = parseResult(await exec("call-1", { task_id: "t-1" }));

      expect(result.success).toBe(true);
      expect(result.task_id).toBe("t-1");
    });

    it("handles cancel failure", async () => {
      mockClient.cancelTask.mockRejectedValue(new Error("Task already completed"));

      const exec = getToolExecute("fin_backtest_remote_cancel");
      const result = parseResult(await exec("call-2", { task_id: "t-1" }));

      expect(result.error).toBe("Task already completed");
    });
  });

  describe("fin_backtest_strategy_check", () => {
    it("returns validation result", async () => {
      vi.mocked(validateStrategy).mockResolvedValue({
        valid: true,
        errors: [],
        warnings: [
          {
            level: "warning",
            category: "structure",
            message: "Missing requirements.txt",
            file: "scripts/requirements.txt",
          },
        ],
      });

      const exec = getToolExecute("fin_backtest_strategy_check");
      const result = parseResult(await exec("call-1", { strategy_path: "/tmp/strat" }));

      expect(result.valid).toBe(true);
      expect(result.warning_count).toBe(1);
      expect(result.error_count).toBe(0);
    });

    it("returns errors for invalid strategy", async () => {
      vi.mocked(validateStrategy).mockResolvedValue({
        valid: false,
        errors: [
          {
            level: "error",
            category: "structure",
            message: "Missing fep.yaml",
            file: "fep.yaml",
          },
        ],
        warnings: [],
      });

      const exec = getToolExecute("fin_backtest_strategy_check");
      const result = parseResult(await exec("call-2", { strategy_path: "/tmp/bad" }));

      expect(result.valid).toBe(false);
      expect(result.error_count).toBe(1);
    });
  });

  describe("fin_backtest_remote_upload", () => {
    it("validates, packs, uploads and polls", async () => {
      vi.mocked(validateStrategy).mockResolvedValue({ valid: true, errors: [], warnings: [] });
      vi.mocked(packStrategy).mockResolvedValue(Buffer.from("fake-zip"));
      mockClient.submit.mockResolvedValue({
        task_id: "t-upload",
        status: "submitted",
        message: "Upload successful",
      });
      vi.mocked(pollUntilDone).mockResolvedValue({
        task: makeTask("completed"),
        report: MOCK_REPORT,
      });

      const exec = getToolExecute("fin_backtest_remote_upload");
      const result = parseResult(
        await exec("call-1", {
          strategy_path: "/tmp/strat",
          engine: "script",
          start_date: "2024-01-01",
          end_date: "2024-12-31",
        }),
      );

      expect(result.success).toBe(true);
      expect(result.archive_size).toBe(8); // "fake-zip" length
      expect(validateStrategy).toHaveBeenCalledWith("/tmp/strat");
      expect(packStrategy).toHaveBeenCalledWith("/tmp/strat");
      expect(pollUntilDone).toHaveBeenCalled();
    });

    it("skips validation when validate=false", async () => {
      vi.mocked(packStrategy).mockResolvedValue(Buffer.from("zip"));
      mockClient.submit.mockResolvedValue({
        task_id: "t-2",
        status: "submitted",
        message: "ok",
      });

      const exec = getToolExecute("fin_backtest_remote_upload");
      await exec("call-2", {
        strategy_path: "/tmp/strat",
        validate: false,
      });

      expect(validateStrategy).not.toHaveBeenCalled();
    });

    it("fails fast on validation errors", async () => {
      vi.mocked(validateStrategy).mockResolvedValue({
        valid: false,
        errors: [{ level: "error", category: "structure", message: "Missing fep.yaml" }],
        warnings: [],
      });

      const exec = getToolExecute("fin_backtest_remote_upload");
      const result = parseResult(await exec("call-3", { strategy_path: "/tmp/bad" }));

      expect(result.success).toBe(false);
      expect(result.message).toContain("Compliance check failed");
      expect(packStrategy).not.toHaveBeenCalled();
    });

    it("uploads without polling when no engine specified", async () => {
      vi.mocked(validateStrategy).mockResolvedValue({ valid: true, errors: [], warnings: [] });
      vi.mocked(packStrategy).mockResolvedValue(Buffer.from("zip"));
      mockClient.submit.mockResolvedValue({
        task_id: "t-3",
        status: "submitted",
        message: "File uploaded",
      });

      const exec = getToolExecute("fin_backtest_remote_upload");
      const result = parseResult(await exec("call-4", { strategy_path: "/tmp/strat" }));

      expect(result.success).toBe(true);
      expect(pollUntilDone).not.toHaveBeenCalled();
    });
  });
});
