import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { KeybindingsManager } from "./keybindings.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it("uses default bindings without creating a missing keybindings file", async () => {
  const agentDir = tempDirs.make("openclaw-keybindings-fresh-");

  const manager = KeybindingsManager.create(agentDir);

  expect(manager.getKeys("app.interrupt")).toEqual(["escape"]);
  expect(manager.getKeys("tui.input.submit")).toEqual(["enter"]);
  expect(manager.getUserBindings()).toEqual({});
  expect(await readdir(agentDir)).toEqual([]);
});

it.each([
  ["cursorUp", "tui.editor.cursorUp"],
  ["cursorDown", "tui.editor.cursorDown"],
  ["cursorLeft", "tui.editor.cursorLeft"],
  ["cursorRight", "tui.editor.cursorRight"],
  ["cursorWordLeft", "tui.editor.cursorWordLeft"],
  ["cursorWordRight", "tui.editor.cursorWordRight"],
  ["cursorLineStart", "tui.editor.cursorLineStart"],
  ["cursorLineEnd", "tui.editor.cursorLineEnd"],
  ["jumpForward", "tui.editor.jumpForward"],
  ["jumpBackward", "tui.editor.jumpBackward"],
  ["pageUp", "tui.editor.pageUp"],
  ["pageDown", "tui.editor.pageDown"],
  ["deleteCharBackward", "tui.editor.deleteCharBackward"],
  ["deleteCharForward", "tui.editor.deleteCharForward"],
  ["deleteWordBackward", "tui.editor.deleteWordBackward"],
  ["deleteWordForward", "tui.editor.deleteWordForward"],
  ["deleteToLineStart", "tui.editor.deleteToLineStart"],
  ["deleteToLineEnd", "tui.editor.deleteToLineEnd"],
  ["yank", "tui.editor.yank"],
  ["yankPop", "tui.editor.yankPop"],
  ["undo", "tui.editor.undo"],
  ["newLine", "tui.input.newLine"],
  ["submit", "tui.input.submit"],
  ["tab", "tui.input.tab"],
  ["copy", "tui.input.copy"],
  ["selectUp", "tui.select.up"],
  ["selectDown", "tui.select.down"],
  ["selectPageUp", "tui.select.pageUp"],
  ["selectPageDown", "tui.select.pageDown"],
  ["selectConfirm", "tui.select.confirm"],
  ["selectCancel", "tui.select.cancel"],
  ["interrupt", "app.interrupt"],
  ["clear", "app.clear"],
  ["exit", "app.exit"],
  ["suspend", "app.suspend"],
  ["cycleThinkingLevel", "app.thinking.cycle"],
  ["cycleModelForward", "app.model.cycleForward"],
  ["cycleModelBackward", "app.model.cycleBackward"],
  ["selectModel", "app.model.select"],
  ["expandTools", "app.tools.expand"],
  ["toggleThinking", "app.thinking.toggle"],
  ["toggleSessionNamedFilter", "app.session.toggleNamedFilter"],
  ["externalEditor", "app.editor.external"],
  ["followUp", "app.message.followUp"],
  ["dequeue", "app.message.dequeue"],
  ["pasteImage", "app.clipboard.pasteImage"],
  ["newSession", "app.session.new"],
  ["tree", "app.session.tree"],
  ["fork", "app.session.fork"],
  ["resume", "app.session.resume"],
  ["treeFoldOrUp", "app.tree.foldOrUp"],
  ["treeUnfoldOrDown", "app.tree.unfoldOrDown"],
  ["treeEditLabel", "app.tree.editLabel"],
  ["treeToggleLabelTimestamp", "app.tree.toggleLabelTimestamp"],
  ["toggleSessionPath", "app.session.togglePath"],
  ["toggleSessionSort", "app.session.toggleSort"],
  ["renameSession", "app.session.rename"],
  ["deleteSession", "app.session.delete"],
  ["deleteSessionNoninvasive", "app.session.deleteNoninvasive"],
])("refuses retired %s with its current %s name and preserves bytes", async (retired, current) => {
  const agentDir = tempDirs.make("openclaw-keybindings-retired-");
  const configPath = join(agentDir, "keybindings.json");
  const original = `${JSON.stringify({ [retired]: "ctrl+x", "custom.action": "ctrl+k" }, null, 4)}\n`;
  await writeFile(configPath, original);

  expect(() => KeybindingsManager.create(agentDir)).toThrowError(
    expect.objectContaining({
      code: "INVALID_CONFIG",
      recovery: "manual",
      message: expect.stringContaining(`${retired}: use ${current}`),
    }),
  );
  expect(await readFile(configPath, "utf8")).toBe(original);
});

it("keeps active bindings when reload refuses retired names beside their replacements", async () => {
  const agentDir = tempDirs.make("openclaw-keybindings-retired-reload-");
  const configPath = join(agentDir, "keybindings.json");
  await writeFile(configPath, JSON.stringify({ "app.interrupt": "ctrl+i" }));
  const manager = KeybindingsManager.create(agentDir);
  const original = '{\n  "interrupt": "ctrl+x",\n  "app.interrupt": "ctrl+k"\n}\n';
  await writeFile(configPath, original);

  expect(() => manager.reload()).toThrowError(
    expect.objectContaining({
      code: "INVALID_CONFIG",
      recovery: "manual",
      message: expect.stringContaining("interrupt: use app.interrupt"),
    }),
  );
  expect(manager.getKeys("app.interrupt")).toEqual(["ctrl+i"]);
  expect(await readFile(configPath, "utf8")).toBe(original);
});

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
