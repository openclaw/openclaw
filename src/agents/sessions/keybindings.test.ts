import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { KeybindingsManager } from "./keybindings.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it("loads legacy overrides with canonical precedence and replaces them on reload", async () => {
  const agentDir = tempDirs.make("openclaw-keybindings-");
  const configPath = join(agentDir, "keybindings.json");
  await writeFile(
    configPath,
    JSON.stringify({
      "extra.z": "ctrl+z",
      followUp: "ctrl+f",
      interrupt: "ctrl+x",
      "app.interrupt": "ctrl+i",
      clear: "ctrl+l",
      "app.clear": 42,
      exit: ["ctrl+q", 1],
      "extra.a": [],
      submit: ["enter", "ctrl+j"],
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
    "extra.a",
    "extra.z",
  ]);

  await writeFile(configPath, JSON.stringify({ followUp: "ctrl+g" }));
  manager.reload();
  expect(manager.getKeys("app.interrupt")).toEqual(["escape"]);
  expect(manager.getKeys("app.message.followUp")).toEqual(["ctrl+g"]);
  expect(manager.getUserBindings()).toEqual({ "app.message.followUp": "ctrl+g" });
});
