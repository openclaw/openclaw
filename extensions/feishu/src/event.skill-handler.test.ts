import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearFeishuSkillSubscriberHandlerCacheForTest,
  executeFeishuSkillSubscriberHandler,
  loadFeishuSkillSubscriberHandler,
} from "./event.skill-handler.js";

const tempDirs: string[] = [];

async function createTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  clearFeishuSkillSubscriberHandlerCacheForTest();
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("event.skill-handler", () => {
  it("loads and executes a skill-local subscriber handler", async () => {
    const skillBaseDir = await createTempDir("openclaw-feishu-subscriber-handler-");
    const handlerFile = path.join(skillBaseDir, "bitable-record-log.handler.mjs");
    await fs.writeFile(
      handlerFile,
      [
        "export async function handleFeishuEvent(context) {",
        "  const log = context.runtime?.log ?? console.log;",
        "  log(`[handler] ${context.delivery.event.eventType} ${context.delivery.event.sourceId}`);",
        "}",
        "",
      ].join("\n"),
      "utf-8",
    );

    const loaded = await loadFeishuSkillSubscriberHandler({
      skillBaseDir,
      handler: {
        file: "./bitable-record-log.handler.mjs",
      },
    });
    expect(loaded.filePath).toBe(handlerFile);

    const log = vi.fn();
    await executeFeishuSkillSubscriberHandler({
      entry: {
        source: {
          skillName: "bitable-record-log",
          skillFilePath: path.join(skillBaseDir, "SKILL.md"),
          skillBaseDir,
        },
        filePath: path.join(skillBaseDir, "feishu-event.subscribers.json"),
        definition: {
          id: "bitable-record-log",
          enabled: true,
          handler: {
            file: "./bitable-record-log.handler.mjs",
          },
        },
      },
      match: {
        subscriptionId: "bitable-record-log",
        delivery: {
          topic: "feishu.drive.file.bitable_record_changed_v1",
          publishedAt: Date.now(),
          event: {
            accountId: "acct-1",
            eventType: "drive.file.bitable_record_changed_v1",
            sourceId: "rec_123",
          },
        },
      } as never,
      runtime: {
        log,
        error: vi.fn(),
      },
    });

    expect(log).toHaveBeenCalledWith("[handler] drive.file.bitable_record_changed_v1 rec_123");
  });
});
