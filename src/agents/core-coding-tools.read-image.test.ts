import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { createSolidPngBuffer } from "../../test/helpers/image-fixtures.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { getImageMetadata } from "../media/image-ops.js";
import { createSandboxedReadTool } from "./agent-tools.read.js";
import { createCoreCodingTools } from "./core-coding-tools.js";
import type { ImageSanitizationLimits } from "./image-sanitization.js";
import { createHostSandboxFsBridge } from "./test-helpers/host-sandbox-fs-bridge.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

const createRead = {
  host: (
    root: string,
    imageSanitization: ImageSanitizationLimits | undefined,
    modelHasVision = true,
  ) =>
    createCoreCodingTools({
      codingRoot: root,
      containmentRoot: root,
      includeBaseCodingTools: true,
      shellTools: "disabled",
      readOnly: true,
      applyPatchEnabled: false,
      applyPatchWorkspaceOnly: true,
      workspaceOnly: true,
      execDefaults: {},
      processDefaults: {},
      imageSanitization,
      modelHasVision,
    }).find((tool) => tool.name === "read")!,
  sandbox: (root: string, imageSanitization: ImageSanitizationLimits | undefined) =>
    createSandboxedReadTool({
      root,
      bridge: createHostSandboxFsBridge(root),
      imageSanitization,
      modelHasVision: true,
    }),
};

it.each([
  ["host", [2400, 1600], undefined, [1200, 800], "2.00"],
  ["host", [2400, 1600], { maxDimensionPx: 800 }, [800, 533], "3.00"],
  ["host", [1600, 1000], undefined, [1200, 750], "1.33"],
  ["sandbox", [2400, 1600], undefined, [1200, 800], "2.00"],
] as const)(
  "describes the delivered image for a %s read of %j (limits %j)",
  async (site, [width, height], imageSanitization, [deliveredWidth, deliveredHeight], factor) => {
    const root = tempDirs.make("openclaw-read-image-");
    await fs.writeFile(
      path.join(root, "screen.png"),
      createSolidPngBuffer(width, height, { r: 17, g: 31, b: 47 }),
    );
    const read = createRead[site](root, imageSanitization);

    const result = await read.execute("read-image", { path: "screen.png" });
    const image = result.content.find((block) => block.type === "image");
    const text = result.content.flatMap((block) => (block.type === "text" ? [block.text] : []));

    expect(image).toBeDefined();
    await expect(getImageMetadata(Buffer.from(image!.data, "base64"))).resolves.toMatchObject({
      width: deliveredWidth,
      height: deliveredHeight,
    });
    expect(text.join("\n")).toContain(
      `[Image: original ${width}x${height}, displayed at ${deliveredWidth}x${deliveredHeight}. Multiply coordinates by ${factor} to map to original image.]`,
    );
  },
);

it("does not prepare an image the model cannot receive", async () => {
  const root = tempDirs.make("openclaw-read-image-");
  await fs.writeFile(
    path.join(root, "screen.png"),
    createSolidPngBuffer(2400, 1600, { r: 17, g: 31, b: 47 }),
  );
  const read = createRead.host(root, undefined, false);

  const result = await read.execute("read-image", { path: "screen.png" });

  expect(result.content).toStrictEqual([
    {
      type: "text",
      text: "Read image file [image/png]\n[Current model does not support images. The image will be omitted from this request.]",
    },
  ]);
});
