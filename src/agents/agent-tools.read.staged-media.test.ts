import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { MediaFact } from "../media/media-facts.js";
import { resolveStagedInputMediaPaths } from "../media/staged-inputs.js";
import { createOpenClawCodingTools } from "./agent-tools.js";
import { getTextContent } from "./test-helpers/agent-tools-fs-helpers.js";
import { createAgentToolsSandboxContext } from "./test-helpers/agent-tools-sandbox-context.js";
import { createHostSandboxFsBridge } from "./test-helpers/host-sandbox-fs-bridge.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const STAGED = "media/inbound/openclaw-staged-00000000-0000-4000-8000-000000000000/input-a.txt";
const REF = "media://inbound/a.txt";

async function readStagedRef(files: Record<string, string>) {
  const root = tempDirs.make("openclaw-sbx-staged-read-");
  for (const [file, text] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await fs.writeFile(path.join(root, file), text);
  }
  const media: MediaFact[] = [{ path: STAGED, url: REF, staged: true }];
  const read = createOpenClawCodingTools({
    workspaceDir: root,
    config: {},
    sandbox: createAgentToolsSandboxContext({
      workspaceDir: root,
      fsBridge: createHostSandboxFsBridge(root),
    }),
    stagedMediaPaths: resolveStagedInputMediaPaths(media),
  }).find((tool) => tool.name === "read");
  return getTextContent(await read!.execute("read-staged", { path: REF }));
}

it("reads a media:// ref from the staged copy through tool assembly", async () => {
  await expect(readStagedRef({ [STAGED]: "staged media" })).resolves.toContain("staged media");
});

it("keeps a real workspace entry authoritative over the staged alias", async () => {
  await expect(
    readStagedRef({ [STAGED]: "staged media", "media/inbound/a.txt": "flat file" }),
  ).resolves.toContain("flat file");
});
