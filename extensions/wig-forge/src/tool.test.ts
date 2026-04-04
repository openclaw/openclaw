import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestPluginApi } from "../../test-utils/plugin-api.js";
import { resolveWigForgeConfig } from "./config.js";
import { createWigForgeTools } from "./tool.js";

describe("wig-forge tools", () => {
  let workspaceDir: string;

  beforeEach(async () => {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "wig-forge-workspace-"));
  });

  afterEach(async () => {
    await fs.rm(workspaceDir, { recursive: true, force: true });
  });

  it("mints, lists, and equips a forged asset", async () => {
    const api = createTestPluginApi({
      id: "wig-forge",
      name: "Wig Forge",
      description: "Wig Forge",
      source: "test",
      config: {},
      runtime: {} as never,
    });
    const tools = createWigForgeTools({
      api,
      ctx: {
        workspaceDir,
        agentId: "openclaw-designer",
      },
      config: resolveWigForgeConfig(),
    });

    const mintTool = tools.find((tool) => tool.name === "wig_forge_mint");
    const listTool = tools.find((tool) => tool.name === "wig_inventory_list");
    const equipTool = tools.find((tool) => tool.name === "wig_inventory_equip");
    const wishCreateTool = tools.find((tool) => tool.name === "wig_wish_create");
    const wishListTool = tools.find((tool) => tool.name === "wig_wish_list");
    const wishGrantTool = tools.find((tool) => tool.name === "wig_wish_grant");

    const png = await sharp({
      create: {
        width: 80,
        height: 80,
        channels: 4,
        background: { r: 20, g: 160, b: 220, alpha: 1 },
      },
    })
      .png()
      .toBuffer();

    const mintResult = await mintTool?.execute?.("tool-mint", {
      sourceDataUrl: `data:image/png;base64,${png.toString("base64")}`,
      nameHint: "Signal Halo",
      styleTags: ["aura", "spark"],
      slotHint: "aura",
      luck: 0.88,
    });

    const mintedAsset = (mintResult?.details as { asset?: { id: string } }).asset;
    expect(mintedAsset?.id).toBeDefined();

    const listResult = await listTool?.execute?.("tool-list", {});
    expect(
      (listResult?.details as { inventory?: { assets: unknown[] } }).inventory?.assets,
    ).toHaveLength(1);

    const equipResult = await equipTool?.execute?.("tool-equip", {
      assetId: mintedAsset?.id,
    });
    expect((equipResult?.details as { asset?: { slot: string } }).asset?.slot).toBe("aura");

    const wishCreateResult = await wishCreateTool?.execute?.("tool-wish-create", {
      title: "Aurora halo",
      slot: "aura",
      desiredRarity: "rare",
      styleTags: ["spark", "celebration"],
      requestedBy: "openclaw-bot",
    });

    const wish = (wishCreateResult?.details as { wish?: { id: string } }).wish;
    expect(wish?.id).toBeDefined();

    const wishListResult = await wishListTool?.execute?.("tool-wish-list", {});
    expect((wishListResult?.details as { active?: unknown[] }).active).toHaveLength(1);

    const wishGrantResult = await wishGrantTool?.execute?.("tool-wish-grant", {
      wishId: wish?.id,
      assetId: mintedAsset?.id,
    });
    expect(
      (wishGrantResult?.details as { wish?: { grantedAssetId?: string } }).wish?.grantedAssetId,
    ).toBe(mintedAsset?.id);

    const inventoryPath = path.join(workspaceDir, ".openclaw", "wig-forge", "inventory.json");
    await expect(fs.readFile(inventoryPath, "utf8")).resolves.toContain(mintedAsset?.id ?? "");
    const wishesPath = path.join(workspaceDir, ".openclaw", "wig-forge", "wishes.json");
    await expect(fs.readFile(wishesPath, "utf8")).resolves.toContain(wish?.id ?? "");
  });
});
