import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import type { SessionEntry } from "../../config/sessions/types.js";
import * as bindingPreparation from "./attempt-execution.cli-session.js";

export function registerClaudeCliHistoryHandoffTests(fixture: {
  getRoot: () => string;
  runFallback: (cwd: string, entry: SessionEntry) => Promise<unknown>;
}) {
  it.each([false, true])(
    "rechecks native history after CLI binding preparation (revoked=%s)",
    async (revoked) => {
      const root = fixture.getRoot();
      const cwd = path.join(root, "handoff-workspace");
      const configDir = path.join(root, "handoff-profile");
      await fs.mkdir(cwd, { recursive: true });
      const projectDir = path.join(
        configDir,
        "projects",
        (await fs.realpath(cwd)).replace(/[^a-zA-Z0-9]/g, "-"),
      );
      await fs.mkdir(projectDir, { recursive: true });
      await fs.writeFile(
        path.join(projectDir, "native-handoff.jsonl"),
        JSON.stringify({
          type: "assistant",
          message: { role: "assistant", content: "Native handoff history" },
        }) + "\n",
      );
      vi.stubEnv("CLAUDE_CONFIG_DIR", configDir);
      const prepare = bindingPreparation.prepareCliSessionBinding;
      const pendingPreparation = vi
        .spyOn(bindingPreparation, "prepareCliSessionBinding")
        .mockImplementationOnce(async (params) => {
          const entry = await prepare(params);
          if (revoked) {
            vi.stubEnv("CLAUDE_CONFIG_DIR", path.join(root, "replacement-profile"));
          }
          return entry;
        });
      try {
        const run = fixture.runFallback(cwd, {
          sessionId: "handoff-session",
          updatedAt: 1,
          cliSessionBindings: {
            "claude-cli": {
              sessionId: "native-handoff",
              cwd,
              transcriptRoot: path.join(configDir, "projects"),
            },
          },
        });
        if (revoked) {
          await expect(run).rejects.toMatchObject({
            name: "NativeHistoryAuthorizationChangedError",
          });
        } else {
          const prompt = await run;
          expect(prompt).toEqual(expect.stringContaining("Continue at handoff"));
          expect(prompt).toEqual(expect.stringContaining("Native handoff history"));
        }
        expect(pendingPreparation).toHaveBeenCalledOnce();
      } finally {
        pendingPreparation.mockRestore();
      }
    },
  );
}
