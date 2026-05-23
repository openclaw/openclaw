import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  deriveNotifyTargetsFromOpenClawConfig,
  repairNotifyTargets,
} from "./notify-config-repair.js";

describe("notify-config-repair", () => {
  it("derives feishu target from channels.feishu.allowFrom", () => {
    const targets = deriveNotifyTargetsFromOpenClawConfig({
      channels: {
        feishu: { allowFrom: ["ou_owner123"] },
      },
    });
    expect(targets).toEqual([{ channel: "feishu", to: "ou_owner123" }]);
  });

  it("derives feishu target from default account allowFrom", () => {
    const targets = deriveNotifyTargetsFromOpenClawConfig({
      channels: {
        feishu: {
          defaultAccount: "main",
          accounts: {
            main: { allowFrom: ["ou_main"] },
            backup: { allowFrom: ["ou_backup"] },
          },
        },
      },
    });
    expect(targets[0]).toEqual({ channel: "feishu", to: "ou_main" });
  });

  it("repairNotifyTargets fills empty targets from channels", () => {
    const config = {
      channels: { feishu: { allowFrom: ["ou_repair"] } },
    };
    const robotConfig: { notify?: { targets?: Array<{ channel: string; to: string }> } } = {};
    const result = repairNotifyTargets(config, robotConfig);
    expect(result.changed).toBe(true);
    expect(robotConfig.notify?.targets).toEqual([{ channel: "feishu", to: "ou_repair" }]);
  });

  it("derives owner from robot.md when channels missing", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "cw-notify-"));
    writeFileSync(
      join(stateDir, "robot.md"),
      "## Owner\nowner_id: ou_robot_owner\nchannel_id: feishu\n",
      "utf8",
    );
    const targets = deriveNotifyTargetsFromOpenClawConfig({}, { stateDir });
    expect(targets).toEqual([{ channel: "feishu", to: "ou_robot_owner" }]);
  });
});
