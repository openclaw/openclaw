import { mkdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, afterEach } from "vitest";
import { isSensitiveImageRejectionError } from "../../embedded-agent-helpers/image-rejection-error.js";
import type { AgentMessage } from "../../runtime/index.js";
import { SessionManager } from "../../sessions/index.js";
import {
  IMAGE_REJECTION_PLACEHOLDER,
  IMAGE_REJECTION_RECOVERY_CUSTOM_TYPE,
  buildRecentImageRejectionRecoveryReplacements,
  recoverRecentSensitiveImageRejection,
} from "./image-rejection-recovery.js";

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length) {
    const dir = tempDirs.pop();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

async function createSessionManager(): Promise<SessionManager> {
  const dir = await mkdtemp(join(tmpdir(), "openclaw-image-recovery-"));
  tempDirs.push(dir);
  const sessionDir = join(dir, "sessions");
  mkdirSync(sessionDir, { recursive: true });
  return SessionManager.create(dir, sessionDir);
}

function imageToolResult(): AgentMessage {
  return {
    role: "toolResult",
    content: [
      { type: "text", text: "Read image file [image/png] /tmp/sensitive.png" },
      { type: "image", data: "abc123", mimeType: "image/png" },
    ],
  } as AgentMessage;
}

describe("sensitive image rejection recovery", () => {
  test("matches only explicit sensitive image rejection errors", () => {
    expect(
      isSensitiveImageRejectionError(
        "input new_sensitive, messages[18]'s content[1] image is sensitive, please check your input (1026)",
      ),
    ).toBe(true);
    expect(isSensitiveImageRejectionError("400 image is sensitive, please check your input")).toBe(
      true,
    );

    expect(isSensitiveImageRejectionError("400 invalid image schema: missing mime type")).toBe(
      false,
    );
    expect(isSensitiveImageRejectionError("network is unreachable")).toBe(false);
    expect(isSensitiveImageRejectionError("model does not support images")).toBe(false);
  });

  test("plans replacement for the most recent user/toolResult image block only", async () => {
    const manager = await createSessionManager();
    manager.appendMessage({ role: "user", content: "hello" });
    const oldImageId = manager.appendMessage(imageToolResult());
    manager.appendMessage({ role: "assistant", content: "old image processed" });
    const recentImageId = manager.appendMessage(imageToolResult());

    const plan = buildRecentImageRejectionRecoveryReplacements({ sessionManager: manager });

    expect(plan.imageBlocks).toBe(1);
    expect(plan.replacements).toHaveLength(1);
    expect(plan.replacements[0]?.entryId).toBe(recentImageId);
    expect(plan.replacements[0]?.entryId).not.toBe(oldImageId);
    expect(JSON.stringify(plan.replacements[0]?.message)).toContain(IMAGE_REJECTION_PLACEHOLDER);
  });

  test("rewrites recent image block and appends recovery context for future prompts", async () => {
    const manager = await createSessionManager();
    manager.appendMessage({ role: "user", content: "please inspect" });
    manager.appendMessage(imageToolResult());

    const result = recoverRecentSensitiveImageRejection({
      sessionManager: manager,
      rawError:
        "input new_sensitive, messages[18]'s content[1] image is sensitive, please check your input (1026)",
      runId: "run-1",
      sessionId: "session-1",
    });

    expect(result.recovered).toBe(true);
    expect(result.imageBlocks).toBe(1);

    const branch = manager.getBranch();
    const serialized = JSON.stringify(branch);
    expect(serialized).toContain(IMAGE_REJECTION_PLACEHOLDER);
    expect(serialized).not.toContain('"type":"image"');
    const recoveryEntry = branch.find(
      (entry) =>
        entry.type === "custom_message" &&
        entry.customType === IMAGE_REJECTION_RECOVERY_CUSTOM_TYPE,
    );
    expect(recoveryEntry).toBeTruthy();

    const context = manager.buildSessionContext();
    expect(JSON.stringify(context.messages)).toContain(
      "provider rejected a recent image block as sensitive",
    );
  });
});
