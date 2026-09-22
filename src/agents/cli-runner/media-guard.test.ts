/** Paired-node attachment guard behavior through the real CLI execution entry point. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { invokeNodeClaudeCliRun } from "../../gateway/node-agent-cli-runtime.js";
import { buildPreparedCliRunContext } from "../cli-runner.test-helpers.js";
import { executePreparedCliRun as executePreparedCliRunImpl } from "./execute.js";
import {
  setCliRunnerExecuteTestDeps,
  supervisorSpawnMock,
  wrapPreparedCliRunWithTestAdmission,
} from "./execute.test-support.js";

vi.mock("../bash-tools.exec-approval-request.js", () => ({
  registerExecApprovalRequestForHostOrThrow: vi.fn(),
  resolveRegisteredExecApprovalDecision: vi.fn(),
}));

const executePreparedCliRun = wrapPreparedCliRunWithTestAdmission(executePreparedCliRunImpl);
const CLAUDE_OK_JSONL = `${JSON.stringify({ type: "result", result: "ok" })}\n`;

beforeEach(() => {
  supervisorSpawnMock.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("paired-node media guard", () => {
  it.each([
    {
      name: "documents and audio",
      media: [
        { path: "/tmp/report.pdf", contentType: "application/pdf" },
        { path: "/tmp/voice.ogg", contentType: "audio/ogg" },
      ],
    },
    {
      name: "a described image with a document",
      media: [
        { path: "/tmp/photo.png", contentType: "image/png", hydrationSuppressed: true },
        { path: "/tmp/report.pdf", contentType: "application/pdf" },
      ],
    },
    {
      name: "a remote-only image",
      media: [{ url: "https://example.invalid/photo.png", contentType: "image/png" }],
    },
  ])("allows $name through node placement", async ({ media }) => {
    const invokeNode = vi.fn(async (params: Parameters<typeof invokeNodeClaudeCliRun>[0]) => {
      params.onProgress(CLAUDE_OK_JSONL);
      return {
        ok: true,
        payloadJSON: JSON.stringify({ exitCode: 0, stderrTail: "", truncated: false }),
      };
    });
    setCliRunnerExecuteTestDeps({ invokeNodeClaudeCliRun: invokeNode });
    const context = buildPreparedCliRunContext({
      sessionEntry: {
        sessionId: "openclaw-session",
        updatedAt: 1,
        execHost: "node",
        execNode: "node-a",
      },
    });
    context.params.media = media;

    await expect(executePreparedCliRun(context)).resolves.toMatchObject({ text: "ok" });
    expect(invokeNode).toHaveBeenCalledOnce();
    expect(supervisorSpawnMock).not.toHaveBeenCalled();
  });
});
