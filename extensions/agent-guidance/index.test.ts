import assert from "node:assert/strict";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import type { PluginHookRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import plugin from "./index.js";
import manifest from "./openclaw.plugin.json" with { type: "json" };

type Hook = PluginHookRegistration<"before_prompt_build">["handler"];
const promptEvent: Parameters<Hook>[0] = { prompt: "Synthetic request.", messages: [] };
const mainContext: Parameters<Hook>[1] = { agentId: "main" };

let directory: string;
const file = (name: string) => path.join(directory, name);
const write = (name: string, content: string | Buffer) => fs.writeFileSync(file(name), content);
const guidance = (extra: Record<string, unknown> = {}) => registerGuidance(config(extra));
const run = (extra: Record<string, unknown> = {}) => guidance(extra)(promptEvent, mainContext);
const valid = (value: unknown) => plugin.configSchema?.safeParse?.(value).success;
beforeEach(() => {
  directory = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), "agent-guidance-")));
  write("instructions.md", "V1");
});
afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));

function config(extra: Record<string, unknown> = {}) {
  return { directory, agents: ["main"], append: ["instructions.md"], ...extra };
}

function register(pluginConfig: OpenClawPluginApi["pluginConfig"], on: OpenClawPluginApi["on"]) {
  plugin.register(createTestPluginApi({ pluginConfig, on }));
}

function registerGuidance(pluginConfig: OpenClawPluginApi["pluginConfig"]) {
  const hooks: PluginHookRegistration[] = [];
  register(pluginConfig, (hookName, handler) => {
    hooks.push({ pluginId: "agent-guidance", source: "test", hookName, handler });
  });
  const registration = hooks.find(
    (r): r is PluginHookRegistration<"before_prompt_build"> => r.hookName === "before_prompt_build",
  );
  assert(registration, "expected before_prompt_build hook registration");
  return registration.handler;
}

it("adds ordered system context only for exact selected agent IDs", async () => {
  expect(manifest.enabledByDefault).toBe(false);
  fs.mkdirSync(file("nested"));
  write("nested/first.md", "First.");
  write("second.md", "Second.");
  const hook = guidance({ prepend: ["nested/first.md", "second.md"] });
  expect(await hook(promptEvent, mainContext)).toEqual({
    prependSystemContext: "First.\n\nSecond.",
    appendSystemContext: "V1",
  });
  const prepend = { prepend: ["second.md"], append: [] };
  expect(await run(prepend)).toEqual({ prependSystemContext: "Second." });
  expect(valid(config(prepend))).toBe(true);
  const misleadingEvent = { ...promptEvent, agentId: "main" };
  expect(await hook(misleadingEvent, { agentId: "other" })).toBeUndefined();
  expect(await hook(promptEvent, { agentId: "MAIN" })).toBeUndefined();
  expect(await hook(promptEvent, {})).toBeUndefined();
});

it("retains a registration snapshot until a new registration reads edited files", async () => {
  expect(valid(config())).toBe(true);
  const hook = guidance();
  write("instructions.md", "V2");
  expect(await hook(promptEvent, mainContext)).toEqual({ appendSystemContext: "V1" });
  expect(await run()).toEqual({ appendSystemContext: "V2" });
});

it.each([
  ["array", []],
  ["unknown field", { extra: true }],
  ["relative directory", { directory: "relative" }],
  ["NUL directory", { directory: "/bad\0" }],
  ["missing agents", { agents: undefined }],
  ["empty agents", { agents: [] }],
  ["blank agent", { agents: [" "] }],
  ["padded agent", { agents: [" main"] }],
  ["duplicate agent", { agents: ["main", "main"] }],
  ["non-string agent", { agents: [1] }],
  ["long agent", { agents: ["a".repeat(129)] }],
  ["too many agents", { agents: Array.from({ length: 65 }, (_, i) => `agent-${i}`) }],
  ["null files", { append: null }],
  ["duplicate files", { prepend: ["instructions.md"] }],
  ["too many files", { append: Array.from({ length: 9 }, (_, i) => `${i}.md`) }],
  ["missing files", { append: undefined }],
  ["empty files", { prepend: [], append: [] }],
])("rejects %s configuration", (_name, extra) => {
  if (Array.isArray(extra)) {
    expect(valid(extra)).toBe(false);
    return;
  }
  const value = _name === "missing files" ? { directory, agents: ["main"] } : config(extra);
  if (["unknown field", "empty agents", "missing files", "empty files"].includes(_name)) {
    expect(valid(value)).toBe(false);
  }
  expect(() => registerGuidance(value)).toThrow("agent-guidance:");
});

it.each([
  "nested/../rules.md",
  "/rules.md",
  "a\\b.md",
  "a//b.md",
  "a/./b.md",
  "a.md:stream",
  "a".repeat(257),
])("rejects unsafe file name %s", (name) =>
  expect(() => guidance({ append: [name] })).toThrow("relative file names"),
);

it.each([" \n", "bad\0text", Buffer.from([0xff]), "a".repeat(16385)])(
  "rejects invalid file content without disclosing text or paths (%#)",
  (content) => {
    write("instructions.md", content);
    // Allowlisted error text excludes both path separators and the payload's NUL.
    expect(() => guidance()).toThrow(
      /^agent-guidance: instruction file 1 could not be loaded; [\w ,;-]+$/,
    );
  },
);

it("counts UTF-8 bytes and separators against the combined limit", async () => {
  const names = ["a.md", "b.md", "c.md", "d.md"];
  names.forEach((name) => write(name, "\u00e9".repeat(8192)));
  expect(() => guidance({ append: names })).toThrow("combined instructions exceed");
  write("d.md", "\u00e9".repeat(8189));
  expect(await run({ append: names })).toBeDefined();
});

function linkedDirectory(root: boolean) {
  fs.mkdirSync(file("real"));
  write("real/target.md", "Synthetic.");
  fs.symlinkSync(file("real"), file("linked"), "junction");
  return root ? { directory: file("linked") } : { append: ["linked/target.md"] };
}
it.each([
  ["directory", () => fs.mkdirSync(file("target.md"))],
  ["symlink", () => fs.symlinkSync(file("instructions.md"), file("target.md"))],
  ["hardlink", () => fs.linkSync(file("instructions.md"), file("target.md"))],
  ["linked parent", () => linkedDirectory(false)],
  ["linked root", () => linkedDirectory(true)],
] as const)("rejects %s with real file helpers", (_kind, prepare) => {
  const extra = prepare();
  const options = config({ append: ["target.md"], ...(typeof extra === "object" ? extra : {}) });
  expect(() => registerGuidance(options)).toThrow("instruction file 1 could not be loaded");
});

it("does not register a partial contribution when a later file fails", () => {
  const on = vi.fn<OpenClawPluginApi["on"]>();
  const value = config({ prepend: ["instructions.md"], append: ["missing.md"] });
  expect(() => register(value, on)).toThrow("instruction file 2");
  expect(on).not.toHaveBeenCalled();
});
