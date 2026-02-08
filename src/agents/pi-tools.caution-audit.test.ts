import { describe, expect, it, vi } from "vitest";
import { wrapToolWithCautionAudit } from "./pi-tools.caution-audit.js";

vi.mock("../security/caution-auditor.js", () => ({
  runCautionAudit: vi.fn(),
}));

vi.mock("../security/caution-defaults.js", () => ({
  isToolCautioned: vi.fn(),
}));

const { runCautionAudit } = await import("../security/caution-auditor.js");
const { isToolCautioned } = await import("../security/caution-defaults.js");

describe("pi-tools.caution-audit", () => {
  const mockModel = { id: "fast", provider: "test", api: "test" } as any;
  const mockRegistry = {} as any;

  const createMockContext = () => ({
    cautionConfig: { enabled: true },
    auditorOptions: { model: "fast", timeoutMs: 3000, failMode: "block" },
    getOriginalUserMessage: () => "Test message",
    isCautionTainted: vi.fn(() => false),
    getLastCautionedToolName: () => "web_fetch",
    setCautionTaint: vi.fn(),
    clearCautionTaint: vi.fn(),
    onAuditBlock: vi.fn(),
    auditorModel: mockModel,
    modelRegistry: mockRegistry,
  });

  const createMockTool = (name: string) => ({
    name,
    description: "test tool",
    parameters: {},
    execute: vi.fn(async () => ({ content: [], details: {} })),
  });

  it("executes tool normally when not tainted", async () => {
    const ctx = createMockContext();
    const tool = createMockTool("write");
    const wrapped = wrapToolWithCautionAudit(tool, ctx);

    await wrapped.execute("call-1", { path: "/tmp/test" }, undefined, undefined);

    expect(tool.execute).toHaveBeenCalled();
    expect(runCautionAudit).not.toHaveBeenCalled();
  });

  it("runs audit when tainted", async () => {
    const ctx = createMockContext();
    ctx.isCautionTainted = vi.fn(() => true);
    vi.mocked(runCautionAudit).mockResolvedValue({
      decision: "allow",
      durationMs: 100,
    });

    const tool = createMockTool("message");
    const wrapped = wrapToolWithCautionAudit(tool, ctx);

    await wrapped.execute("call-2", { to: "alice" }, undefined, undefined);

    expect(runCautionAudit).toHaveBeenCalled();
    expect(tool.execute).toHaveBeenCalled();
  });

  it("blocks tool when audit blocks", async () => {
    const ctx = createMockContext();
    ctx.isCautionTainted = vi.fn(() => true);
    vi.mocked(runCautionAudit).mockResolvedValue({
      decision: "block",
      reason: "not aligned",
      durationMs: 100,
    });

    const tool = createMockTool("message");
    const wrapped = wrapToolWithCautionAudit(tool, ctx);

    await expect(
      wrapped.execute("call-3", { to: "attacker@evil.com" }, undefined, undefined),
    ).rejects.toThrow("Caution Mode blocked");

    expect(tool.execute).not.toHaveBeenCalled();
    expect(ctx.onAuditBlock).toHaveBeenCalledWith("message", "not aligned");
  });

  it("sets taint after cautioned tool executes", async () => {
    const ctx = createMockContext();
    vi.mocked(isToolCautioned).mockReturnValue(true);

    const tool = createMockTool("web_fetch");
    const wrapped = wrapToolWithCautionAudit(tool, ctx);

    await wrapped.execute("call-4", { url: "https://example.com" }, undefined, undefined);

    expect(ctx.setCautionTaint).toHaveBeenCalledWith("web_fetch");
  });

  it("clears taint after non-cautioned tool executes", async () => {
    const ctx = createMockContext();
    ctx.isCautionTainted = vi.fn(() => true);
    vi.mocked(isToolCautioned).mockReturnValue(false);

    const tool = createMockTool("read");
    const wrapped = wrapToolWithCautionAudit(tool, ctx);

    await wrapped.execute("call-5", { path: "/tmp/file" }, undefined, undefined);

    expect(ctx.clearCautionTaint).toHaveBeenCalled();
  });

  it("passes signal to audit", async () => {
    const ctx = createMockContext();
    ctx.isCautionTainted = vi.fn(() => true);
    vi.mocked(runCautionAudit).mockResolvedValue({
      decision: "allow",
      durationMs: 100,
    });

    const tool = createMockTool("message");
    const wrapped = wrapToolWithCautionAudit(tool, ctx);
    const signal = new AbortController().signal;

    await wrapped.execute("call-6", { to: "alice" }, signal, undefined);

    expect(runCautionAudit).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ signal }),
    );
  });
});
