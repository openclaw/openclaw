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

function multiImageToolResult(): AgentMessage {
  return {
    role: "toolResult",
    content: [
      { type: "text", text: "Read 2 image files" },
      { type: "image", data: "alpha", mimeType: "image/png" },
      { type: "image", data: "beta", mimeType: "image/png" },
    ],
  } as AgentMessage;
}

function getImageBlockCount(message: AgentMessage | undefined): number {
  if (!message) return 0;
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return 0;
  return content.filter(
    (b) => !!b && typeof b === "object" && (b as { type?: unknown }).type === "image",
  ).length;
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

  test("does not touch earlier images when a newer image is rejected in a later turn", async () => {
    const manager = await createSessionManager();
    // Turn 1: A is read.
    manager.appendMessage(imageToolResult());
    manager.appendMessage({ role: "assistant", content: "ok, A processed" });
    // Turn 2: B is read and rejected.
    manager.appendMessage(imageToolResult());

    const result = recoverRecentSensitiveImageRejection({
      sessionManager: manager,
      rawError: "input new_sensitive, messages[18] content[1] image is sensitive (1026)",
    });
    expect(result.recovered).toBe(true);
    expect(result.imageBlocks).toBe(1);

    const branch = manager.getBranch();
    const messages = branch
      .filter((e): e is Extract<typeof e, { type: "message" }> => e.type === "message")
      .map((e) => e.message);
    // The first image toolResult (A) must still have its image block.
    const msgA = messages[0];
    const msgB = messages[messages.length - 1];
    expect(getImageBlockCount(msgA)).toBe(1);
    expect(getImageBlockCount(msgB)).toBe(0);
    expect(JSON.stringify(msgA)).not.toContain(IMAGE_REJECTION_PLACEHOLDER);
    expect(JSON.stringify(msgB)).toContain(IMAGE_REJECTION_PLACEHOLDER);
  });

  test("after recovery, subsequent turns with new images are not affected by old recovery", async () => {
    const manager = await createSessionManager();
    // Turn 1: image A is read and rejected.
    manager.appendMessage(imageToolResult());
    const firstRecovery = recoverRecentSensitiveImageRejection({
      sessionManager: manager,
      rawError: "input new_sensitive, messages[0] content[1] image is sensitive (1026)",
    });
    expect(firstRecovery.recovered).toBe(true);

    // Turn 2: image C is read and processed normally (no rejection).
    manager.appendMessage(imageToolResult());
    manager.appendMessage({ role: "assistant", content: "ok, C" });

    // Turn 3: image D is read and rejected.
    manager.appendMessage(imageToolResult());
    const secondRecovery = recoverRecentSensitiveImageRejection({
      sessionManager: manager,
      rawError: "input new_sensitive, messages[N] content[1] image is sensitive (1026)",
    });
    expect(secondRecovery.recovered).toBe(true);
    expect(secondRecovery.imageBlocks).toBe(1);

    // After both recoveries: A is text (recovered), C is still image, D is text (just recovered).
    const finalMessages = manager
      .getBranch()
      .filter((e): e is Extract<typeof e, { type: "message" }> => e.type === "message")
      .map((e) => e.message);
    // Filter to only toolResult messages (ignore assistant "ok, C" and the recovery entries).
    const imageMessages = finalMessages.filter(
      (m) => (m as { role?: unknown }).role === "toolResult",
    );
    expect(imageMessages).toHaveLength(3);
    expect(getImageBlockCount(imageMessages[0])).toBe(0); // A: stripped by first recovery
    expect(getImageBlockCount(imageMessages[1])).toBe(1); // C: untouched
    expect(getImageBlockCount(imageMessages[2])).toBe(0); // D: stripped by second recovery

    // The placeholder count should be 2 across the whole branch (one for A, one for D).
    const allSerialized = JSON.stringify(finalMessages);
    // Use split to count literal occurrences (avoids regex escaping of [, ;, etc in placeholder text)
    const placeholderCount = allSerialized.split(IMAGE_REJECTION_PLACEHOLDER).length - 1;
    expect(placeholderCount).toBe(2);
  });

  test("multi-image toolResult: recovery strips ALL images in that message (known precision trade-off)", async () => {
    const manager = await createSessionManager();
    // Single toolResult carrying 2 images in its content array.
    // The provider's rejection hints at messages[N] content[M], but our walk-from-end
    // matches the whole message and strips every image in it.
    manager.appendMessage(multiImageToolResult());

    const result = recoverRecentSensitiveImageRejection({
      sessionManager: manager,
      rawError: "input new_sensitive, messages[0] content[1] image is sensitive (1026)",
    });
    expect(result.recovered).toBe(true);
    // KNOWN LIMITATION: both images get stripped, even though the rejection may have
    // been about only one of them. The user loses the other (still-valid) image's data.
    expect(result.imageBlocks).toBe(2);

    const imageMessages = manager
      .getBranch()
      .filter((e): e is Extract<typeof e, { type: "message" }> => e.type === "message")
      .filter((e) => (e.message as { role?: unknown }).role === "toolResult")
      .map((e) => e.message);
    expect(imageMessages).toHaveLength(1);
    expect(getImageBlockCount(imageMessages[0])).toBe(0);
    const serialized = JSON.stringify(imageMessages[0]);
    const occurrences = serialized.split(IMAGE_REJECTION_PLACEHOLDER).length - 1;
    expect(occurrences).toBe(2); // placeholder appears for BOTH images
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
