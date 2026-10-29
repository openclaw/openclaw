import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { countSessionLogMentions } from "./fixture-utils.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

it("counts only regular session logs, never linked files or directories", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "qa-session-scan-"));
  roots.push(root);
  const logs = path.join(root, "logs");
  const outside = path.join(root, "outside");
  await fs.mkdir(path.join(logs, "nested"), { recursive: true });
  await fs.mkdir(outside);
  await fs.writeFile(
    path.join(logs, "nested/actual.jsonl"),
    '{"role":"assistant","content":"target"}',
  );
  await fs.writeFile(
    path.join(outside, "private.jsonl"),
    '{"role":"assistant","content":"target target"}',
  );
  await fs.symlink(outside, path.join(logs, "outside"), "dir");
  await fs.symlink(path.join(outside, "private.jsonl"), path.join(logs, "linked.jsonl"), "file");
  await fs.symlink(logs, path.join(logs, "nested/up"), "dir");
  await expect(
    countSessionLogMentions({
      sessionsDir: path.join(logs, "nested/actual.jsonl"),
      needles: { target: "target" },
    }),
  ).rejects.toMatchObject({ code: "ENOTDIR" });
  await expect(
    countSessionLogMentions({
      sessionsDir: path.join(logs, "nested/up"),
      needles: { target: "target" },
    }),
  ).rejects.toMatchObject({ code: "ERR_DIRECTORY_WALK_ROOT_SYMLINK" });
  await expect(
    countSessionLogMentions({ sessionsDir: logs, needles: { target: "target" } }),
  ).resolves.toEqual({ target: 1 });
  await expect(
    countSessionLogMentions({
      sessionsDir: path.join(root, "missing"),
      needles: { target: "target" },
    }),
  ).resolves.toEqual({ target: 0 });
});
