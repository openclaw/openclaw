import { describe, expect, it } from "vitest";
import {
  resolveDiscordSlashCommandConfig,
  resolveDiscordSlashCommandDeployConfig,
} from "./commands.js";

describe("resolveDiscordSlashCommandConfig", () => {
  it("defaults ephemeral to true when undefined", () => {
    const result = resolveDiscordSlashCommandConfig(undefined);
    expect(result.ephemeral).toBe(true);
  });

  it("defaults ephemeral to true when not explicitly false", () => {
    const result = resolveDiscordSlashCommandConfig({});
    expect(result.ephemeral).toBe(true);
  });

  it("sets ephemeral to false when explicitly false", () => {
    const result = resolveDiscordSlashCommandConfig({ ephemeral: false });
    expect(result.ephemeral).toBe(false);
  });

  it("keeps ephemeral true when explicitly true", () => {
    const result = resolveDiscordSlashCommandConfig({ ephemeral: true });
    expect(result.ephemeral).toBe(true);
  });
});

describe("resolveDiscordSlashCommandDeployConfig", () => {
  it("defaults mode to changed-only", () => {
    expect(resolveDiscordSlashCommandDeployConfig(undefined).mode).toBe("changed-only");
    expect(resolveDiscordSlashCommandDeployConfig({}).mode).toBe("changed-only");
  });

  it("accepts configured modes", () => {
    expect(resolveDiscordSlashCommandDeployConfig("changed-only").mode).toBe("changed-only");
    expect(resolveDiscordSlashCommandDeployConfig({ mode: "always" }).mode).toBe("always");
    expect(resolveDiscordSlashCommandDeployConfig({ mode: "changed-only" }).mode).toBe(
      "changed-only",
    );
    expect(resolveDiscordSlashCommandDeployConfig({ mode: "disabled" }).mode).toBe("disabled");
  });
});
