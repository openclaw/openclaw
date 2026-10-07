import fs from "node:fs";
import path from "node:path";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it } from "vitest";
import { MAX_ATTACHMENT_BYTES } from "./store-constants.js";
import { createWorkboardSqliteTestStore } from "./test/sqlite-store.js";
import { createWorkboardTools } from "./tools.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const PNG_HEADER = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");

async function setup() {
  const workspaceDir = tempDirs.make("openclaw-workboard-attach-ws-");
  const outsideDir = tempDirs.make("openclaw-workboard-attach-out-");
  const store = createWorkboardSqliteTestStore();
  const card = await store.create({ title: "Attach from path" });
  const tool = createWorkboardTools({ store, context: { agentId: "main", workspaceDir } }).find(
    (entry) => entry.name === "workboard_attachment_add",
  );
  if (!tool) {
    throw new Error("missing workboard_attachment_add");
  }
  const attach = (params: Record<string, unknown>) =>
    tool.execute("call-attach", { id: card.id, ...params });
  return { workspaceDir, outsideDir, store, card, attach };
}

describe("workboard_attachment_add path", () => {
  it("stores a workspace file larger than the old cap with detected type and basename", async () => {
    const { workspaceDir, store, attach } = await setup();
    const bytes = Buffer.concat([PNG_HEADER, Buffer.alloc(1024 * 1024, 7)]);
    fs.mkdirSync(path.join(workspaceDir, "shots"));
    fs.writeFileSync(path.join(workspaceDir, "shots", "hero.png"), bytes);

    const result = await attach({ path: "shots/hero.png", note: "hero" });
    const card = (result.details as { card: { metadata: { attachments: unknown[] } } }).card;
    const [attachment] = card.metadata.attachments as Array<Record<string, unknown>>;
    expect(attachment).toMatchObject({
      fileName: "hero.png",
      mimeType: "image/png",
      byteSize: bytes.length,
      note: "hero",
    });
    const stored = await store.getAttachment(attachment?.id as string);
    expect(Buffer.from(stored?.contentBase64 ?? "", "base64").equals(bytes)).toBe(true);
  });

  it("keeps explicit file name and MIME type and accepts absolute workspace paths", async () => {
    const { workspaceDir, attach } = await setup();
    const filePath = path.join(workspaceDir, "report");
    fs.writeFileSync(filePath, "plain");

    const result = await attach({
      path: filePath,
      fileName: "report.md",
      mimeType: "text/markdown",
    });
    expect(result.details).toMatchObject({
      card: {
        metadata: {
          attachments: [
            expect.objectContaining({ fileName: "report.md", mimeType: "text/markdown" }),
          ],
        },
      },
    });
  });

  it("rejects paths and symlinks that leave the workspace", async () => {
    const { workspaceDir, outsideDir, attach } = await setup();
    const secret = path.join(outsideDir, "secret.txt");
    fs.writeFileSync(secret, "secret");
    fs.symlinkSync(secret, path.join(workspaceDir, "link.txt"));

    for (const candidate of [secret, `../${path.basename(outsideDir)}/secret.txt`, "link.txt"]) {
      await expect(attach({ path: candidate })).rejects.toThrow(/inside the agent workspace/);
    }
  });

  it("rejects files over the attachment cap", async () => {
    const { workspaceDir, attach } = await setup();
    const filePath = path.join(workspaceDir, "big.bin");
    fs.writeFileSync(filePath, "");
    fs.truncateSync(filePath, MAX_ATTACHMENT_BYTES + 1);

    await expect(attach({ path: "big.bin" })).rejects.toThrow(/attachment must be between/);
  });

  it("rejects path combined with contentBase64", async () => {
    const { workspaceDir, attach } = await setup();
    fs.writeFileSync(path.join(workspaceDir, "a.txt"), "a");

    await expect(
      attach({
        path: "a.txt",
        fileName: "a.txt",
        contentBase64: Buffer.from("a").toString("base64"),
      }),
    ).rejects.toThrow(/either path or contentBase64/);
  });
});
