import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { KeybindingsManager } from "./keybindings.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it("loads valid overrides in canonical order and replaces them on reload", async () => {
  const agentDir = tempDirs.make("openclaw-keybindings-");
  const configPath = join(agentDir, "keybindings.json");
  await writeFile(
    configPath,
    JSON.stringify({
      "extra.z": "ctrl+z",
      "app.message.followUp": "ctrl+f",
      "app.interrupt": "ctrl+i",
      "app.clear": 42,
      "app.exit": ["ctrl+q", 1],
      "extra.a": [],
      ["__proto__"]: ["ctrl+p"],
      toString: "ctrl+b",
      "tui.input.submit": ["enter", "ctrl+j"],
    }),
  );

  const manager = KeybindingsManager.create(agentDir);
  expect(manager.getKeys("app.interrupt")).toEqual(["ctrl+i"]);
  expect(manager.getKeys("app.clear")).toEqual(["ctrl+c"]);
  expect(manager.getKeys("app.exit")).toEqual(["ctrl+d"]);
  expect(manager.getKeys("app.message.followUp")).toEqual(["ctrl+f"]);
  expect(manager.getKeys("tui.input.submit")).toEqual(["enter", "ctrl+j"]);
  expect(Object.keys(manager.getUserBindings())).toEqual([
    "tui.input.submit",
    "app.interrupt",
    "app.message.followUp",
    "__proto__",
    "extra.a",
    "extra.z",
    "toString",
  ]);
  expect(manager.getUserBindings()).toMatchObject({
    ["__proto__"]: ["ctrl+p"],
    toString: "ctrl+b",
  });

  await writeFile(
    configPath,
    JSON.stringify({ "app.message.followUp": "ctrl+g", ["__proto__"]: "ctrl+y" }),
  );
  manager.reload();
  expect(manager.getKeys("app.interrupt")).toEqual(["escape"]);
  expect(manager.getKeys("app.message.followUp")).toEqual(["ctrl+g"]);
  expect(manager.getUserBindings()).toEqual({
    "app.message.followUp": "ctrl+g",
    ["__proto__"]: "ctrl+y",
  });
});
