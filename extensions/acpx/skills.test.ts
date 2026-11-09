import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const execFileAsync = promisify(execFile);

// Execute the Bash examples through the documented bin, without a vendor account.
it.skipIf(process.platform === "win32").each([
  { source: "skill", agent: "cursor", sessionName: "oc-cursor-fixture" },
  { source: "CLI docs", agent: "openclaw", sessionName: "codex-bridge" },
])(
  "runs the $source session templates in their target directory",
  async ({ source, agent, sessionName }) => {
    const root = tempDirs.make("openclaw-acp-router-");
    const home = path.join(root, "home");
    const target = path.join(root, "target");
    const peer = path.join(root, "peer");
    for (const dir of [path.join(home, ".acpx"), target, peer]) {
      await fs.mkdir(dir, { recursive: true });
    }
    const cli = fileURLToPath(new URL("./node_modules/.bin/acpx", import.meta.url));
    const fixture = fileURLToPath(
      new URL("../../test/fixtures/acp/owner-agent.mjs", import.meta.url),
    );
    await fs.writeFile(
      path.join(home, ".acpx/config.json"),
      JSON.stringify({
        agents: {
          [agent]: {
            command: [process.execPath, fixture, peer]
              .map((value) => JSON.stringify(value))
              .join(" "),
          },
        },
      }),
    );
    let persistentTemplate: string;
    let oneShotTemplate: string | undefined;
    let cancelTemplate: string | undefined;
    let closeTemplate: string | undefined;
    if (source === "skill") {
      const skill = await fs.readFile(
        new URL("./skills/acp-router/SKILL.md", import.meta.url),
        "utf8",
      );
      const section = skill.match(/### Command templates\n([\s\S]*?)### Harness aliases/)?.[1];
      assert(section, "ACP command templates section is missing");
      const snippets = [...section.matchAll(/```bash\n([\s\S]*?)```/g)].map((match) => {
        assert(match[1], "ACP command template is empty");
        return match[1]
          .replaceAll("codex", "cursor")
          .replaceAll("<conversationId>", "fixture")
          .replaceAll("<workspacePath>", '"$TARGET"')
          .replaceAll("<prompt>", "fictional");
      });
      const [persistent, oneShot, cancel, close] = snippets;
      assert(persistent && oneShot && cancel && close);
      persistentTemplate = persistent;
      oneShotTemplate = oneShot;
      cancelTemplate = cancel;
      closeTemplate = close;
    } else {
      const docs = await fs.readFile(new URL("../../docs/cli/acp.md", import.meta.url), "utf8");
      const example = docs.match(
        /# Persistent named session for follow-up turns\n([\s\S]*?)```/,
      )?.[1];
      assert(example, "ACP CLI persistent-session example is missing");
      persistentTemplate = example
        .replaceAll("/path/to/repo", '"$TARGET"')
        .replaceAll(
          "Ask my OpenClaw work agent for recent context relevant to this repo.",
          "fictional",
        );
    }
    const run = (command: string) =>
      execFileAsync("/bin/sh", ["-eu", "-c", command], {
        cwd: home,
        env: {
          HOME: home,
          TMPDIR: root,
          PATH: `${path.dirname(cli)}${path.delimiter}${process.env.PATH ?? ""}`,
          ACPX_CMD: cli,
          TARGET: target,
          NO_COLOR: "1",
        },
        timeout: 10_000,
      });
    try {
      const persistent = await run(persistentTemplate);
      expect(persistent.stdout).toContain('"history":["fictional"]');
      // List all scopes: omitting --cwd must expose home here, not silently pass.
      const sessions = await run(`\${ACPX_CMD} --format json ${agent} sessions list`);
      expect(JSON.parse(sessions.stdout)).toEqual([
        expect.objectContaining({ name: sessionName, cwd: await fs.realpath(target) }),
      ]);
      const continuation = await run(persistentTemplate);
      expect(continuation.stdout).toContain('"history":["fictional","fictional"]');
      if (cancelTemplate) {
        await run(cancelTemplate);
      }
      if (oneShotTemplate) {
        const oneShot = await run(oneShotTemplate);
        expect(oneShot.stdout).toContain('"history":["fictional"]');
      }
      if (closeTemplate) {
        await run(closeTemplate);
      }
    } finally {
      // Clean both scopes even when a broken example created the session in home.
      for (const cwd of [target, home]) {
        await run(
          `\${ACPX_CMD} --cwd ${JSON.stringify(cwd)} ${agent} sessions close ${sessionName}`,
        ).catch(() => {});
      }
    }
  },
);
