import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import { TelegramUserbotDriver, type TelegramUserbotUpdate } from "./userbot-driver.runtime.js";
import { loadTelegramUserbotSkillRuntime } from "./userbot-skill.runtime.js";

const tempRoots: string[] = [];
const drivers: TelegramUserbotDriver[] = [];

function tempRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "telegram-userbot-runtime-test-"));
  tempRoots.push(root);
  return root;
}

function writeDriver(setup: string[], commands: string[], root = tempRoot()) {
  const scriptPath = path.join(root, "user-driver.py");
  fs.writeFileSync(
    scriptPath,
    [
      "import json",
      "import sys",
      ...setup,
      "print(json.dumps({'type':'ready','chatId':-1001,'user':{'id':100}}), flush=True)",
      "for line in sys.stdin:",
      "    request = json.loads(line)",
      ...commands,
    ].join("\n"),
  );
  return scriptPath;
}

async function startDriver(
  userDriverPath: string,
  options: Partial<Parameters<typeof TelegramUserbotDriver.start>[0]> = {},
) {
  const driver = await TelegramUserbotDriver.start({
    chatId: "-1001",
    driverEnv: {},
    leaseHealth: { assertHealthy() {}, whenUnhealthy: new Promise<Error>(() => {}) },
    onUpdate() {},
    ...options,
    userDriverPath,
  });
  drivers.push(driver);
  return driver;
}

function entity(offset: number, length: number, type = "textEntityTypeCode") {
  return { offset, length, type: { "@type": type } };
}

function message(overrides: Partial<TelegramUserbotUpdate> = {}): TelegramUserbotUpdate {
  return {
    kind: "message",
    chatId: -1001,
    messageId: 11,
    senderId: 100,
    timestamp: 1000,
    text: "😀 a   b x",
    entities: [],
    ...overrides,
  };
}

const pythonJson = (name: string, value: unknown) =>
  `${name} = json.loads(${JSON.stringify(JSON.stringify(value))})`;

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(drivers.splice(0).map((driver) => driver.close())).finally(() => {
    tempRoots.splice(0).forEach((root) => fs.rmSync(root, { recursive: true, force: true }));
  });
});

it("keeps one process for commands and streamed formatting edits", async () => {
  const text = "😀 a   b x";
  const url = "https://example.com/qa";
  const entities = [
    entity(3, 5),
    { offset: 9, length: 1, type: { "@type": "textEntityTypeTextUrl", url } },
  ];
  const editedEntities = [entity(3, 5, "textEntityTypeBold")];
  const expression = { "@type": "richTextMathematicalExpression", expression: "x" };
  const link = { "@type": "richTextUrl", url, text: expression };
  const richMessage = {
    "@type": "richMessage",
    is_full: true,
    is_rtl: false,
    blocks: [{ "@type": "pageBlockParagraph", text: link }],
  };
  const initial = message({ messageId: 12, senderId: 200, contentType: "messagePhoto", entities });
  const edit = { ...initial, kind: "edit" as const, contentType: "messageVideo" };
  const richEdit = { ...edit, contentType: "messageRichMessage", text: "x", entities: [] };
  const expected = [
    initial,
    { ...edit, entities: editedEntities },
    { ...edit, entities: [] },
    { ...richEdit, richMessage },
    { ...richEdit, richMessage: { ...richMessage, is_full: false } },
    { ...richEdit, contentType: "messageText" },
  ];
  const result = message({ entities, contentType: "messageText", forumTopicId: 42 });
  const scriptPath = writeDriver(
    [pythonJson("updates", expected), pythonJson("result", result), "result.pop('kind')"],
    [
      "    assert request['chatId'] == '-2002' and request['forumTopicId'] == 42",
      "    assert request['text'] == result['text']",
      "    for update in updates:",
      "        if update['contentType'] == 'messageText':",
      "            update = {**update, 'richMessage':None}",
      "        print(json.dumps({'type':'update','update':update}), flush=True)",
      "    print(json.dumps({'type':'response','id':request['id'],'result':result}), flush=True)",
    ],
  );
  const updates: TelegramUserbotUpdate[] = [];
  const driver = await startDriver(scriptPath, {
    expectedUserId: "100",
    onUpdate(update) {
      updates.push(update);
    },
  });
  await expect(driver.send({ text, chatId: "-2002", forumTopicId: 42 })).resolves.toEqual(result);
  await vi.waitFor(() => expect(updates).toHaveLength(6));
  expect(updates).toEqual(expected);
  expect(updates[5]).not.toHaveProperty("richMessage");
  expect(() => driver.assertHealthy()).not.toThrow();
});

it.each<[string, unknown, boolean?]>([
  ["missing entities", undefined],
  ["non-array entities", {}],
  ["non-object entity", [null]],
  ["negative offset", [entity(-1, 1)]],
  ["fractional length", [entity(3, 1.5)]],
  ["empty range", [entity(3, 0)]],
  ["range past the text", [entity(3, 8)], true],
  ["start inside a surrogate pair", [entity(1, 1)], true],
  ["end inside a surrogate pair", [entity(0, 1)]],
  ["missing entity type", [{ offset: 3, length: 1, type: {} }], true],
])("rejects %s at the child protocol boundary", async (_name, entities, streamed = false) => {
  const invalid = { ...message(), entities };
  const scriptPath = writeDriver(
    [pythonJson("result", invalid), "result.pop('kind')"],
    [
      `    if ${streamed ? "True" : "False"}:`,
      "        print(json.dumps({'type':'update','update':{**result, 'kind':'message'}}), flush=True)",
      "        result = {**result, 'entities':[]}",
      "    print(json.dumps({'type':'response','id':request['id'],'result':result}), flush=True)",
    ],
  );
  const onUpdate = vi.fn();
  const driver = await startDriver(scriptPath, { onUpdate });
  await expect(driver.send({ text: invalid.text })).rejects.toThrow(/invalid entit/u);
  expect(onUpdate).not.toHaveBeenCalled();
});

it("stops a delayed TDLib send before its final effect after lease loss", async () => {
  const root = tempRoot();
  const markerPath = path.join(root, "sent.txt");
  const scriptPath = writeDriver(
    ["import pathlib", "import time"],
    ["    time.sleep(1)", `    pathlib.Path(${JSON.stringify(markerPath)}).write_text('sent')`],
    root,
  );
  const { promise: whenUnhealthy, resolve: revoke } = Promise.withResolvers<Error>();
  const driver = await startDriver(scriptPath, {
    leaseHealth: { assertHealthy() {}, whenUnhealthy },
  });

  const sending = driver.send({ text: "must not send" });
  revoke(new Error("lease revoked"));

  await expect(sending).rejects.toThrow("lease revoked");
  await delay(1_100);
  expect(fs.existsSync(markerPath)).toBe(false);
});

it("loads the selected repository skill from a different working directory", async () => {
  const repoRoot = tempRoot();
  const skillPath = ".agents/skills/telegram-e2e-userbot";
  for (const relative of [skillPath, "extensions/qa-lab/src/qa-credentials-bootstrap.ts"]) {
    const destination = path.join(repoRoot, relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.cpSync(path.join(process.cwd(), relative), destination, { recursive: true });
  }
  vi.stubEnv("TELEGRAM_E2E_SKILL_DIR", undefined);
  const runtime = await loadTelegramUserbotSkillRuntime({ repoRoot });

  expect(runtime.userDriverPath).toBe(path.join(repoRoot, skillPath, "scripts/user-driver.py"));
  expect(() => runtime.parseCredential({})).toThrow("unsupported schema or environment");
  const stateRoot = runtime.createStateRoot();
  expect(fs.statSync(stateRoot).isDirectory()).toBe(true);
  fs.rmSync(stateRoot, { recursive: true, force: true });
});
