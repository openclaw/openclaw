import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ApplicationCommandType, type APIApplicationCommand } from "discord-api-types/v10";
import { describe, expect, test, vi } from "vitest";
import { DiscordCommandDeployer, __testing } from "./command-deploy.js";
import { BaseCommand } from "./commands.js";
import type { RequestClient } from "./rest.js";

const { commandsEqual } = __testing;

/**
 * Regression tests for Discord slash-command reconcile/deploy equality.
 *
 * These protect against a class of bugs where Discord's server-side storage
 * normalization causes our desired descriptor to re-compare unequal to the
 * command Discord returns, which leads to a spurious `PATCH` on every
 * gateway startup and, under the per-application rate limit, a cascade of
 * `429` responses that silently drop some commands until the next restart.
 */
describe("commandsEqual", () => {
  // Shape of what Discord returns on `GET /applications/{appId}/commands`.
  // Fields like `version`, `dm_permission`, `nsfw`, `application_id` are
  // always present on the server side but absent from our locally-serialized
  // desired descriptors — they must therefore be ignored by the comparator.
  function currentFromDiscord(
    overrides: Partial<APIApplicationCommand> = {},
  ): APIApplicationCommand {
    return {
      id: "cmd-1",
      application_id: "app",
      type: 1,
      name: "ping",
      description: "ping the bot",
      version: "v1",
      default_member_permissions: null,
      dm_permission: true,
      nsfw: false,
      ...overrides,
    } as APIApplicationCommand;
  }

  // Shape of what a `BaseCommand.serialize()` produces locally.
  function desiredFromLocal(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      name: "ping",
      description: "ping the bot",
      type: 1,
      default_member_permissions: null,
      ...overrides,
    };
  }

  test("ignores Discord server-side default fields (dm_permission, nsfw, version, id, application_id)", () => {
    expect(commandsEqual(currentFromDiscord(), desiredFromLocal())).toBe(true);
  });

  test("ignores Discord null localization maps when local command omits them", () => {
    const current = currentFromDiscord({
      name_localizations: null,
      description_localizations: null,
      options: [
        {
          type: 3,
          name: "name",
          name_localizations: null,
          description: "Skill name",
          description_localizations: null,
        } as any,
      ],
    });
    const desired = desiredFromLocal({
      options: [{ name: "name", description: "Skill name", type: 3 }],
    });
    expect(commandsEqual(current, desired)).toBe(true);
  });

  test("treats `required: false` on an option as equivalent to field absent", () => {
    const current = currentFromDiscord({
      name: "skill",
      description: "Run a skill.",
      options: [{ type: 3, name: "name", description: "Skill name" } as any],
    });
    const desired = desiredFromLocal({
      name: "skill",
      description: "Run a skill.",
      options: [{ name: "name", description: "Skill name", type: 3, required: false }],
    });
    expect(commandsEqual(current, desired)).toBe(true);
  });

  test("keeps `required: true` meaningful", () => {
    const current = currentFromDiscord({
      name: "skill",
      description: "Run a skill.",
      options: [{ type: 3, name: "name", description: "Skill name" } as any],
    });
    const desired = desiredFromLocal({
      name: "skill",
      description: "Run a skill.",
      options: [{ name: "name", description: "Skill name", type: 3, required: true }],
    });
    expect(commandsEqual(current, desired)).toBe(false);
  });

  test("treats CJK descriptions with `\\n` separators as equal to Discord's collapsed form", () => {
    // Discord server collapses whitespace between CJK characters when storing
    // command descriptions, so our local desired `\n`-separated description
    // round-trips back without the newline.
    const current = currentFromDiscord({
      description:
        "将任意文本转化为杂志质感 HTML 信息卡片，并自动截图保存为图片。支持直接输入 URL。",
    });
    const desired = desiredFromLocal({
      description:
        "将任意文本转化为杂志质感 HTML 信息卡片，并自动截图保存为图片。\n支持直接输入 URL。",
    });
    expect(commandsEqual(current, desired)).toBe(true);
  });

  test("treats mixed CJK/ASCII descriptions with consecutive whitespace as equal to collapsed form", () => {
    const current = currentFromDiscord({
      description: "联网操作策略框架。访问需登录站点时触发。",
    });
    const desired = desiredFromLocal({
      description: "联网操作策略框架。\n\n访问需登录站点时触发。",
    });
    expect(commandsEqual(current, desired)).toBe(true);
  });

  test("treats localized descriptions with CJK whitespace as equal to Discord's collapsed form", () => {
    const current = currentFromDiscord({
      description_localizations: {
        "zh-CN": "第一行说明。第二行说明。",
      },
    });
    const desired = desiredFromLocal({
      description_localizations: {
        "zh-CN": "第一行说明。\n第二行说明。",
      },
    });
    expect(commandsEqual(current, desired)).toBe(true);
  });

  test("treats option localized descriptions with CJK whitespace as equal to Discord's collapsed form", () => {
    const current = currentFromDiscord({
      name: "skill",
      description: "Run a skill.",
      options: [
        {
          type: 3,
          name: "name",
          description: "Skill name",
          description_localizations: { "zh-CN": "技能名称。直接输入。" },
        } as any,
      ],
    });
    const desired = desiredFromLocal({
      name: "skill",
      description: "Run a skill.",
      options: [
        {
          name: "name",
          description: "Skill name",
          description_localizations: { "zh-CN": "技能名称。\n直接输入。" },
          type: 3,
        },
      ],
    });
    expect(commandsEqual(current, desired)).toBe(true);
  });

  test("keeps localized substantive description differences meaningful", () => {
    const current = currentFromDiscord({
      description_localizations: {
        "zh-CN": "旧说明",
      },
    });
    const desired = desiredFromLocal({
      description_localizations: {
        "zh-CN": "新说明",
      },
    });
    expect(commandsEqual(current, desired)).toBe(false);
  });

  test("keeps substantive description differences meaningful", () => {
    const current = currentFromDiscord({ description: "old text" });
    const desired = desiredFromLocal({ description: "new text" });
    expect(commandsEqual(current, desired)).toBe(false);
  });

  test("treats ASCII `\\n` as whitespace and collapses it to space for comparison", () => {
    // For pure ASCII descriptions, `\n` collapses to a single space so
    // "ping the bot" == "ping\nthe bot". The contract is: whitespace
    // differences (ASCII or CJK-boundary) are never substantive after
    // Discord's server normalization.
    const current = currentFromDiscord({ description: "ping the bot" });
    const desired = desiredFromLocal({ description: "ping\nthe bot" });
    expect(commandsEqual(current, desired)).toBe(true);
  });
});

/**
 * Regression for #77359: when two Discord accounts share the same on-disk
 * deploy-cache file (the default in multi-bot setups) the persisted hash key
 * must be scoped by application/client id. Otherwise a later account whose
 * command set hashes the same as the first account's reuses the first
 * account's hash and skips reconciling its own Discord application — leaving
 * "This application has no commands" in the secondary bot's Integrations panel.
 */
describe("DiscordCommandDeployer cache scoping (multi-application)", () => {
  class StaticCommand extends BaseCommand {
    name: string;
    description = "ping the bot";
    type = ApplicationCommandType.ChatInput;
    constructor(name: string) {
      super();
      this.name = name;
    }
    serializeOptions() {
      return undefined;
    }
  }

  function createRest(): RequestClient {
    return {
      get: vi.fn(async () => []),
      post: vi.fn(async () => undefined),
      patch: vi.fn(async () => undefined),
      put: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
    } as unknown as RequestClient;
  }

  test("two applications with identical command sets each reconcile their own application", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-discord-multi-app-"));
    const hashStorePath = path.join(dir, "command-deploy-cache.json");
    const commands = [new StaticCommand("ping")];

    const restA = createRest();
    const deployerA = new DiscordCommandDeployer({
      clientId: "app-default",
      commands,
      hashStorePath,
      rest: () => restA,
    });
    await deployerA.deploy({ mode: "reconcile" });

    const restB = createRest();
    const deployerB = new DiscordCommandDeployer({
      clientId: "app-secondary",
      commands,
      hashStorePath,
      rest: () => restB,
    });
    await deployerB.deploy({ mode: "reconcile" });

    // The first deploy issues a list + create against application "app-default".
    expect(restA.get).toHaveBeenCalledTimes(1);
    expect(restA.post).toHaveBeenCalledTimes(1);
    // The second deploy MUST also list + create against "app-secondary"; before
    // the fix it short-circuited on the shared `global:reconcile` hash and
    // never touched its own Discord application.
    expect(restB.get).toHaveBeenCalledTimes(1);
    expect(restB.post).toHaveBeenCalledTimes(1);
  });

  test("re-deploying the same application still hits the persisted cache", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-discord-multi-app-"));
    const hashStorePath = path.join(dir, "command-deploy-cache.json");
    const commands = [new StaticCommand("ping")];

    const restFirst = createRest();
    await new DiscordCommandDeployer({
      clientId: "app-default",
      commands,
      hashStorePath,
      rest: () => restFirst,
    }).deploy({ mode: "reconcile" });

    const restSecond = createRest();
    await new DiscordCommandDeployer({
      clientId: "app-default",
      commands,
      hashStorePath,
      rest: () => restSecond,
    }).deploy({ mode: "reconcile" });

    expect(restFirst.get).toHaveBeenCalledTimes(1);
    expect(restFirst.post).toHaveBeenCalledTimes(1);
    // Same application, same command set, same hash file => skip reconcile.
    expect(restSecond.get).not.toHaveBeenCalled();
    expect(restSecond.post).not.toHaveBeenCalled();
  });

  test("persisted cache keys are namespaced by application id", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-discord-multi-app-"));
    const hashStorePath = path.join(dir, "command-deploy-cache.json");
    const commands = [new StaticCommand("ping")];

    await new DiscordCommandDeployer({
      clientId: "app-default",
      commands,
      hashStorePath,
      rest: () => createRest(),
    }).deploy({ mode: "reconcile" });

    await new DiscordCommandDeployer({
      clientId: "app-secondary",
      commands,
      hashStorePath,
      rest: () => createRest(),
    }).deploy({ mode: "reconcile" });

    const raw = await fs.readFile(hashStorePath, "utf8");
    const parsed = JSON.parse(raw) as { hashes: Record<string, string> };
    const keys = Object.keys(parsed.hashes);
    expect(keys).toContain("app:app-default:global:reconcile");
    expect(keys).toContain("app:app-secondary:global:reconcile");
    expect(keys).not.toContain("global:reconcile");
  });
});
