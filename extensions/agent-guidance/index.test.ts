import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import type { PluginHookRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import plugin from "./index.js";
import manifest from "./openclaw.plugin.json" with { type: "json" };

type BeforePromptBuildHook = PluginHookRegistration<"before_prompt_build">["handler"];
const promptEvent: Parameters<BeforePromptBuildHook>[0] = {
  prompt: "Synthetic request.",
  messages: [],
};
const mainContext: Parameters<BeforePromptBuildHook>[1] = { agentId: "main" };

describe("agent-guidance", () => {
  let directory: string;
  beforeEach(() => {
    // A bare directory is sufficient: no HOME, config, provider or process state.
    directory = realpathSync(mkdtempSync(path.join(tmpdir(), "agent-guidance-")));
    writeFileSync(path.join(directory, "instructions.md"), "Synthetic guidance V1.");
  });
  afterEach(() => rmSync(directory, { recursive: true, force: true }));

  function config(extra: Record<string, unknown> = {}) {
    return { directory, agents: ["main"], append: ["instructions.md"], ...extra };
  }

  function registerGuidance(
    pluginConfig: OpenClawPluginApi["pluginConfig"],
  ): BeforePromptBuildHook {
    const registrations: PluginHookRegistration[] = [];
    plugin.register(
      createTestPluginApi({
        pluginConfig,
        on(hookName, handler) {
          registrations.push({ pluginId: "agent-guidance", source: "test", hookName, handler });
        },
      }),
    );
    const registration = registrations.find(
      (entry): entry is PluginHookRegistration<"before_prompt_build"> =>
        entry.hookName === "before_prompt_build",
    );
    if (!registration) {
      throw new Error("expected before_prompt_build hook registration");
    }
    return registration.handler;
  }

  it("registers only the native prompt hook and is disabled by default", () => {
    const on = vi.fn<OpenClawPluginApi["on"]>();
    plugin.register(createTestPluginApi({ pluginConfig: config(), on }));
    expect(on).toHaveBeenCalledExactlyOnceWith("before_prompt_build", expect.any(Function));
    expect(plugin.id).toBe("agent-guidance");
    expect(manifest.enabledByDefault).toBe(false);
  });

  it("adds ordered system context only for exact selected agent IDs", async () => {
    writeFileSync(path.join(directory, "first.md"), "First.");
    writeFileSync(path.join(directory, "second.md"), "Second.");
    const hook = registerGuidance(config({ prepend: ["first.md", "second.md"] }));
    expect(await hook(promptEvent, mainContext)).toEqual({
      prependSystemContext: "First.\n\nSecond.",
      appendSystemContext: "Synthetic guidance V1.",
    });
    const misleadingEvent = { ...promptEvent, agentId: "main" };
    expect(await hook(misleadingEvent, { agentId: "other" })).toBeUndefined();
    expect(await hook(promptEvent, { agentId: "MAIN" })).toBeUndefined();
    expect(await hook(promptEvent, {})).toBeUndefined();
  });

  it("retains a registration snapshot until a new registration reads edited files", async () => {
    const hook = registerGuidance(config());
    writeFileSync(path.join(directory, "instructions.md"), "Synthetic guidance V2.");
    expect(await hook(promptEvent, mainContext)).toEqual({
      appendSystemContext: "Synthetic guidance V1.",
    });
    expect(await registerGuidance(config())(promptEvent, mainContext)).toEqual({
      appendSystemContext: "Synthetic guidance V2.",
    });
  });

  it("accepts nested relative names", async () => {
    mkdirSync(path.join(directory, "nested"));
    writeFileSync(path.join(directory, "nested", "rules.md"), "Nested.");
    expect(
      await registerGuidance(config({ append: ["nested/rules.md"] }))(promptEvent, mainContext),
    ).toEqual({
      appendSystemContext: "Nested.",
    });
  });

  it.each([
    ["missing", undefined],
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
    ["no files", { append: [] }],
    ["null files", { append: null }],
    ["duplicate files", { prepend: ["instructions.md"] }],
    ["too many files", { append: Array.from({ length: 9 }, (_, i) => `${i}.md`) }],
  ])("rejects %s configuration", (_name, extra) => {
    if (Array.isArray(extra)) {
      expect(plugin.configSchema?.safeParse?.(extra).success).toBe(false);
      return;
    }
    const value = extra === undefined ? undefined : config(extra);
    expect(() => registerGuidance(value)).toThrow("agent-guidance:");
  });

  it.each([
    "../rules.md",
    "nested/../rules.md",
    "/rules.md",
    "C:/rules.md",
    "a\\b.md",
    "a//b.md",
    "a/./b.md",
    "a.md:stream",
    "https://host/file",
    "rules.md\0",
    "a/",
    "a".repeat(257),
  ])("rejects unsafe file name %s", (name) =>
    expect(() => registerGuidance(config({ append: [name] }))).toThrow("relative file names"),
  );

  it.each(["", " \n", "bad\0text", Buffer.from([0xff]), "a".repeat(16385)])(
    "rejects invalid file content without disclosing text or paths (%#)",
    (content) => {
      writeFileSync(path.join(directory, "instructions.md"), content);
      expect(() => registerGuidance(config())).toThrow("instruction file 1 could not be loaded");
      try {
        registerGuidance(config());
      } catch (error) {
        expect(String(error)).not.toContain(directory);
        expect(String(error)).not.toContain("bad\0text");
      }
    },
  );

  it("counts UTF-8 bytes and separators against the combined limit", async () => {
    const names = ["a.md", "b.md", "c.md", "d.md"];
    for (const name of names) {
      writeFileSync(path.join(directory, name), "\u00e9".repeat(8192));
    }
    expect(() => registerGuidance(config({ append: names }))).toThrow(
      "combined instructions exceed",
    );
    writeFileSync(path.join(directory, "d.md"), "\u00e9".repeat(8189));
    expect(
      await registerGuidance(config({ append: names }))(promptEvent, mainContext),
    ).toBeDefined();
  });

  it.each(["missing", "directory", "symlink", "hardlink", "linked parent", "linked root"])(
    "rejects %s with real file helpers",
    (kind) => {
      let options = config({ append: ["target.md"] });
      const target = path.join(directory, "target.md");
      if (kind === "directory") {
        mkdirSync(target);
      } else if (kind === "hardlink") {
        linkSync(path.join(directory, "instructions.md"), target);
      } else if (kind === "symlink") {
        symlinkSync(path.join(directory, "instructions.md"), target);
      } else if (kind === "linked parent" || kind === "linked root") {
        mkdirSync(path.join(directory, "real"));
        writeFileSync(path.join(directory, "real", "target.md"), "Synthetic.");
        symlinkSync(path.join(directory, "real"), path.join(directory, "linked"), "junction");
        options =
          kind === "linked root"
            ? config({ directory: path.join(directory, "linked"), append: ["target.md"] })
            : config({ append: ["linked/target.md"] });
      }
      expect(() => registerGuidance(options)).toThrow("instruction file 1 could not be loaded");
    },
  );

  it("does not register a partial contribution when a later file fails", () => {
    const on = vi.fn<OpenClawPluginApi["on"]>();
    expect(() =>
      plugin.register(
        createTestPluginApi({
          pluginConfig: config({ prepend: ["instructions.md"], append: ["missing.md"] }),
          on,
        }),
      ),
    ).toThrow("instruction file 2");
    expect(on).not.toHaveBeenCalled();
  });

  it("validates configuration with the native JSON schema", () => {
    expect(plugin.configSchema?.safeParse?.(config()).success).toBe(true);
    expect(plugin.configSchema?.safeParse?.(config({ unknown: true })).success).toBe(false);
    expect(plugin.configSchema?.safeParse?.(config({ agents: [] })).success).toBe(false);
  });

  it.each([{}, { prepend: [] }, { append: [] }, { prepend: [], append: [] }])(
    "rejects configuration without instruction files before registration (%#)",
    (files) => {
      const value = { directory, agents: ["main"], ...files };
      expect(plugin.configSchema?.safeParse?.(value).success).toBe(false);
      expect(() => registerGuidance(value)).toThrow("configure 1 to 8 instruction files in total");
    },
  );

  it.each([
    { prepend: ["instructions.md"] },
    { append: ["instructions.md"] },
    { prepend: [], append: ["instructions.md"] },
    { prepend: ["instructions.md"], append: [] },
    { prepend: ["instructions.md"], append: ["second.md"] },
  ])("accepts nonempty instruction lists through schema and registration (%#)", async (files) => {
    writeFileSync(path.join(directory, "second.md"), "Second.");
    const value = { directory, agents: ["main"], ...files };
    expect(plugin.configSchema?.safeParse?.(value).success).toBe(true);
    expect(await registerGuidance(value)(promptEvent, mainContext)).toBeDefined();
  });
});
