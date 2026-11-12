import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as observation from "../infra/owned-directory-observation.js";
import { drainGlobalSingletonLifecycleState } from "../shared/global-singleton.js";
import { loadBootstrapConversationStarters } from "./bootstrap-conversation-starters.js";
import * as files from "./workspace-file-read.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(async () => {
  await drainGlobalSingletonLifecycleState();
  vi.restoreAllMocks();
});

it.each([
  [
    "conversationStarters:\n  - ' Brief me '                 # first prompt\n  - Set up a repository",
    ["Brief me", "Set up a repository"],
  ],
  ["conversationStarters: []", undefined],
  ["conversationStarters: Brief me", undefined],
  ["conversationStarters: [Brief me, ' ']", undefined],
  ["conversationStarters: [12]", undefined],
  ["conversationStarters: [unterminated", undefined],
])(
  "reads optional YAML starters without treating prose as metadata: %s",
  async (yaml, expected) => {
    const workspace = dirs.make("bootstrap-starters-");
    const file = path.join(workspace, "BOOTSTRAP.md");
    await fs.writeFile(file, "---\n" + yaml + "\n---\n# Setup\nHelp set up the workspace.");
    expect(await loadBootstrapConversationStarters(workspace)).toEqual(expected);
  },
);

it("shares unchanged reads and refreshes edits, deletion and recreation on workspace events", async () => {
  const workspace = dirs.make("bootstrap-starters-lifecycle-");
  const file = path.join(workspace, "BOOTSTRAP.md");
  const watches = new Map<string, (filename?: string) => void>();
  const close = vi.fn();
  vi.spyOn(observation, "observeOwnedDirectory").mockImplementation((dir, onChange) => {
    watches.set(dir, onChange);
    return { close, isWatching: () => true };
  });
  const read = vi.spyOn(files, "readWorkspaceFileWithGuards");
  const write = (prompt: string) =>
    fs.writeFile(
      file,
      "---\nconversationStarters: [" + JSON.stringify(prompt) + "]\n---\nSetup instructions.",
    );
  const notify = () => watches.get(workspace)!("BOOTSTRAP.md");
  await write("Set up a repository");
  expect(
    await Promise.all([
      loadBootstrapConversationStarters(workspace),
      loadBootstrapConversationStarters(workspace),
    ]),
  ).toEqual([["Set up a repository"], ["Set up a repository"]]);
  expect(await loadBootstrapConversationStarters(workspace)).toEqual(["Set up a repository"]);
  expect(read).toHaveBeenCalledTimes(1);
  await write("Brief me");
  notify();
  expect(await loadBootstrapConversationStarters(workspace)).toEqual(["Brief me"]);
  await fs.unlink(file);
  notify();
  expect(await loadBootstrapConversationStarters(workspace)).toBeUndefined();
  await write("Start again");
  notify();
  expect(await loadBootstrapConversationStarters(workspace)).toEqual(["Start again"]);
  await drainGlobalSingletonLifecycleState();
  expect(close).toHaveBeenCalledOnce();
});
