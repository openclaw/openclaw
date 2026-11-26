/** Tests that the provider handoff replays images with the attempt's configured limits. */
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createSolidPngBuffer } from "../../../../test/helpers/image-fixtures.js";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import { readImageMetadataFromHeader } from "../../../media/image-header-metadata.js";
import { buildPersistedUserTurnMessage } from "../../../sessions/user-turn-transcript.message.js";
import { convertToLlm } from "../../sessions/messages.js";
import { hydratePromptMediaMessages } from "./images.js";
import { createProviderContextMaterializer } from "./provider-context-materializer.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

/** Width/height of the single image block the provider would receive. */
async function providerImageSize(
  materializer: ReturnType<typeof createProviderContextMaterializer>,
  context: Parameters<ReturnType<typeof createProviderContextMaterializer>>[0]["context"],
) {
  const provider = await materializer({ context });
  const content = provider.messages[0]?.content;
  const block = Array.isArray(content)
    ? content.find((entry) => entry.type === "image")
    : undefined;
  if (block?.type !== "image") {
    throw new Error("Expected the provider context to carry the image");
  }
  const metadata = readImageMetadataFromHeader(Buffer.from(block.data, "base64"));
  return { width: metadata?.width, height: metadata?.height };
}

async function buildFixture(imageMaxDimensionPx?: number) {
  const workspaceDir = tempDirs.make("openclaw-provider-image-limits-");
  const imagePath = path.join(workspaceDir, "wide.png");
  await fs.mkdir(path.dirname(imagePath), { recursive: true });
  await fs.writeFile(imagePath, createSolidPngBuffer(80, 40, { r: 0, g: 0, b: 255 }));
  const message = buildPersistedUserTurnMessage({
    text: "inspect",
    timestamp: 1,
    media: [{ path: imagePath, contentType: "image/png" }],
  });
  const hydrated = await hydratePromptMediaMessages([message], {
    workspaceDir,
    model: { input: ["text", "image"] },
    workspaceOnly: true,
  });
  const materializer = createProviderContextMaterializer({
    attempt: {
      sessionId: "provider-limits",
      workspaceDir,
      config:
        imageMaxDimensionPx === undefined ? {} : { agents: { defaults: { imageMaxDimensionPx } } },
    } as EmbeddedRunAttemptParams,
    workspaceDir,
    workspaceOnly: true,
    sessionAgentId: "main",
  });
  return { materializer, context: { messages: convertToLlm(hydrated) } };
}

describe("provider context materializer image limits", () => {
  it("keeps a source under the configured dimension limit byte-for-byte", async () => {
    const { materializer, context } = await buildFixture();
    expect(await providerImageSize(materializer, context)).toEqual({ width: 80, height: 40 });
  });

  it("resizes provider replay to the configured agents.defaults limit", async () => {
    // The handoff used to omit the limit, so the built-in 1200px default applied and
    // this 80px-wide source came through unresized.
    const { materializer, context } = await buildFixture(40);
    expect(await providerImageSize(materializer, context)).toEqual({ width: 40, height: 20 });
  });
});
