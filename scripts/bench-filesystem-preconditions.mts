import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// Pair with an external filesystem-call observer; fixture setup is not a warm action.
const root = await mkdtemp(path.join(tmpdir(), "openclaw-fs-preconditions-"));
const workspace = path.join(root, "workspace");
const state = path.join(root, "state");
const fixture = path.join(workspace, "fixture.md");
const text = "Synthetic filesystem benchmark fixture.\n";
const keys = ["HOME", "OPENCLAW_HOME", "OPENCLAW_STATE_DIR", "OPENCLAW_CONFIG_PATH"] as const;
const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
Object.assign(process.env, {
  HOME: root,
  OPENCLAW_HOME: root,
  OPENCLAW_STATE_DIR: state,
  OPENCLAW_CONFIG_PATH: path.join(state, "openclaw.json"),
});
try {
  await mkdir(workspace);
  await mkdir(state);
  await writeFile(fixture, text);
  const { loadPromptTemplates } = await import("../src/agents/sessions/prompt-templates.js");
  const { createReadTool } = await import("../src/agents/sessions/tools/read.js");
  const tool = createReadTool(workspace);
  for (let sample = 0; sample < 10; sample += 1) {
    const prompts = loadPromptTemplates({
      cwd: workspace,
      agentDir: state,
      promptPaths: [fixture],
    });
    assert.equal(prompts.length, 1);
    assert.equal(prompts[0]?.sourceInfo.baseDir, workspace);
    const result = await tool.execute("fs-benchmark", { path: fixture });
    assert.ok(
      result.content.some((part) => part.type === "text" && part.text.includes(text.trim())),
    );
  }
  console.log(JSON.stringify({ samples: 10, promptLoads: 10, localReads: 10 }));
} finally {
  for (const key of keys) {
    if (previous[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = previous[key];
    }
  }
  await rm(root, { recursive: true, force: true });
}
