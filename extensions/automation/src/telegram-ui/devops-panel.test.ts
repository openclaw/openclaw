import { describe, expect, it } from "vitest";
import { buildDeployConfirm, buildDevOpsPanel, buildPRListPanel } from "./devops-panel.js";

describe("telegram-ui devops panel", () => {
  it("shows failure summary and fix button when failures exist", () => {
    const panel = buildDevOpsPanel([
      {
        provider: "github-actions",
        repo: "openclaw/openclaw",
        branch: "main",
        status: "failure",
        url: "https://ci.example/fail",
        updatedAt: Date.now() - 60_000,
      },
      {
        provider: "github-actions",
        repo: "openclaw/openclaw",
        branch: "main",
        status: "running",
        url: "https://ci.example/run",
        updatedAt: Date.now() - 30_000,
      },
    ]);
    const textBlock = panel.blocks.find((block) => block.type === "text");
    expect(textBlock?.type).toBe("text");
    if (!textBlock || textBlock.type !== "text") {
      return;
    }
    expect(textBlock.text).toContain("⚠️ 1 失敗");

    const values = panel.blocks
      .filter((block) => block.type === "buttons")
      .flatMap((block) => block.buttons.map((btn) => btn.value));
    expect(values).toContain("sc:dv:fix");
  });

  it("limits review buttons to three PR entries", () => {
    const panel = buildPRListPanel([
      { number: 1, title: "PR-1", state: "open", draft: false },
      { number: 2, title: "PR-2", state: "open", draft: false },
      { number: 3, title: "PR-3", state: "open", draft: false },
      { number: 4, title: "PR-4", state: "open", draft: false },
    ]);
    const values = panel.blocks
      .filter((block) => block.type === "buttons")
      .flatMap((block) => block.buttons.map((btn) => btn.value));
    expect(values.filter((value) => value.startsWith("sc:dv:rv:"))).toEqual([
      "sc:dv:rv:1",
      "sc:dv:rv:2",
      "sc:dv:rv:3",
    ]);
  });

  it("keeps deploy confirm callbacks within telegram 64-byte limit", () => {
    const prod = buildDeployConfirm("production");
    const staging = buildDeployConfirm("staging");
    const values = [...prod.blocks, ...staging.blocks]
      .filter((block) => block.type === "buttons")
      .flatMap((block) => block.buttons.map((btn) => btn.value));
    for (const value of values) {
      expect(Buffer.byteLength(value, "utf8")).toBeLessThanOrEqual(64);
    }
  });

  it("uses danger style for production deploy and success style for non-prod", () => {
    const prod = buildDeployConfirm("production");
    const staging = buildDeployConfirm("staging");

    const prodConfirm = prod.blocks
      .filter((block) => block.type === "buttons")
      .flatMap((block) => block.buttons)
      .find((btn) => btn.value.startsWith("sc:dv:depgo:"));
    const stagingConfirm = staging.blocks
      .filter((block) => block.type === "buttons")
      .flatMap((block) => block.buttons)
      .find((btn) => btn.value.startsWith("sc:dv:depgo:"));

    expect(prodConfirm?.style).toBe("danger");
    expect(stagingConfirm?.style).toBe("success");
  });

  it("escapes non-prod env text and falls back callback when env is too long", () => {
    const panel = buildDeployConfirm('<staging>&"x"');
    const textBlock = panel.blocks.find((block) => block.type === "text");
    expect(textBlock?.type).toBe("text");
    if (!textBlock || textBlock.type !== "text") {
      return;
    }
    expect(textBlock.text).toContain('&lt;staging&gt;&amp;"x"');

    const longPanel = buildDeployConfirm("x".repeat(80));
    const confirmButton = longPanel.blocks
      .filter((block) => block.type === "buttons")
      .flatMap((block) => block.buttons)
      .find((btn) => btn.label === "✅ 確認部署");
    expect(confirmButton?.value).toBe("sc:devops");
  });

  it("uses Chinese DevOps-facing wording on panel text and navigation labels", () => {
    const panel = buildPRListPanel([{ number: 1, title: "PR-1", state: "open", draft: true }]);
    const textBlock = panel.blocks.find((block) => block.type === "text");
    expect(textBlock?.type).toBe("text");
    if (!textBlock || textBlock.type !== "text") {
      return;
    }
    expect(textBlock.text).toContain("開啟中的 PR");
    expect(textBlock.text).toContain("[草稿]");

    const labels = panel.blocks
      .filter((block) => block.type === "buttons")
      .flatMap((block) => block.buttons.map((btn) => btn.label));
    expect(labels).toContain("← 維運");
    for (const label of labels) {
      expect(label).not.toMatch(/\bDevOps\b/i);
    }
  });
});
