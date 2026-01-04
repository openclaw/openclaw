import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { createClawdbotCodingTools } from "./pi-tools.js";

describe("createClawdbotCodingTools", () => {
  it("merges properties for union tool schemas", () => {
    const tools = createClawdbotCodingTools();
    const browser = tools.find((tool) => tool.name === "browser");
    expect(browser).toBeDefined();
    const parameters = browser?.parameters as {
      anyOf?: unknown[];
      properties?: Record<string, unknown>;
      required?: string[];
    };
    expect(parameters.properties?.action).toBeDefined();
    expect(parameters.properties?.controlUrl).toBeDefined();
    expect(parameters.properties?.targetUrl).toBeDefined();
    expect(parameters.properties?.request).toBeDefined();
    expect(parameters.required ?? []).toContain("action");
  });

  it("preserves union action values in merged schema", () => {
    const tools = createClawdbotCodingTools();
    const toolNames = ["browser", "canvas", "nodes", "cron", "gateway"];

    for (const name of toolNames) {
      const tool = tools.find((candidate) => candidate.name === name);
      expect(tool).toBeDefined();
      const parameters = tool?.parameters as {
        anyOf?: Array<{ properties?: Record<string, unknown> }>;
        properties?: Record<string, unknown>;
      };
      if (!Array.isArray(parameters.anyOf) || parameters.anyOf.length === 0) {
        continue;
      }
      const actionValues = new Set<string>();
      for (const variant of parameters.anyOf ?? []) {
        const action = variant?.properties?.action as
          | { const?: unknown; enum?: unknown[] }
          | undefined;
        if (typeof action?.const === "string") actionValues.add(action.const);
        if (Array.isArray(action?.enum)) {
          for (const value of action.enum) {
            if (typeof value === "string") actionValues.add(value);
          }
        }
      }

      if (actionValues.size <= 1) {
        continue;
      }
      const mergedAction = parameters.properties?.action as
        | { const?: unknown; enum?: unknown[] }
        | undefined;
      const mergedValues = new Set<string>();
      if (typeof mergedAction?.const === "string") {
        mergedValues.add(mergedAction.const);
      }
      if (Array.isArray(mergedAction?.enum)) {
        for (const value of mergedAction.enum) {
          if (typeof value === "string") mergedValues.add(value);
        }
      }

      expect(actionValues.size).toBeGreaterThan(1);
      expect(mergedValues.size).toBe(actionValues.size);
      for (const value of actionValues) {
        expect(mergedValues.has(value)).toBe(true);
      }
    }
  });

  it("includes bash and process tools", () => {
    const tools = createClawdbotCodingTools();
    expect(tools.some((tool) => tool.name === "bash")).toBe(true);
    expect(tools.some((tool) => tool.name === "process")).toBe(true);
  });

  it("scopes discord tool to discord surface", () => {
    const other = createClawdbotCodingTools({ surface: "whatsapp" });
    expect(other.some((tool) => tool.name === "discord")).toBe(false);

    const discord = createClawdbotCodingTools({ surface: "discord" });
    expect(discord.some((tool) => tool.name === "discord")).toBe(true);
  });

  it("scopes slack tool to slack surface", () => {
    const other = createClawdbotCodingTools({ surface: "whatsapp" });
    expect(other.some((tool) => tool.name === "slack")).toBe(false);

    const slack = createClawdbotCodingTools({ surface: "slack" });
    expect(slack.some((tool) => tool.name === "slack")).toBe(true);
  });

  it("keeps read tool image metadata intact", async () => {
    const tools = createClawdbotCodingTools();
    const readTool = tools.find((tool) => tool.name === "read");
    expect(readTool).toBeDefined();

    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdbot-read-"));
    try {
      const imagePath = path.join(tmpDir, "sample.png");
      const png = await sharp({
        create: {
          width: 8,
          height: 8,
          channels: 3,
          background: { r: 0, g: 128, b: 255 },
        },
      })
        .png()
        .toBuffer();
      await fs.writeFile(imagePath, png);

      const result = await readTool?.execute("tool-1", {
        path: imagePath,
      });

      expect(result?.content?.some((block) => block.type === "image")).toBe(
        true,
      );
      const text = result?.content?.find((block) => block.type === "text") as
        | { text?: string }
        | undefined;
      expect(text?.text ?? "").toContain("Read image file [image/png]");
      const image = result?.content?.find((block) => block.type === "image") as
        | { mimeType?: string }
        | undefined;
      expect(image?.mimeType).toBe("image/png");
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("returns text content without image blocks for text files", async () => {
    const tools = createClawdbotCodingTools();
    const readTool = tools.find((tool) => tool.name === "read");
    expect(readTool).toBeDefined();

    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdbot-read-"));
    try {
      const textPath = path.join(tmpDir, "sample.txt");
      const contents = "Hello from clawdbot read tool.";
      await fs.writeFile(textPath, contents, "utf8");

      const result = await readTool?.execute("tool-2", {
        path: textPath,
      });

      expect(result?.content?.some((block) => block.type === "image")).toBe(
        false,
      );
      const textBlocks = result?.content?.filter(
        (block) => block.type === "text",
      ) as Array<{ text?: string }> | undefined;
      expect(textBlocks?.length ?? 0).toBeGreaterThan(0);
      const combinedText = textBlocks
        ?.map((block) => block.text ?? "")
        .join("\n");
      expect(combinedText).toContain(contents);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("filters tools by sandbox policy", () => {
    const sandbox = {
      enabled: true,
      sessionKey: "sandbox:test",
      workspaceDir: path.join(os.tmpdir(), "clawdbot-sandbox"),
      containerName: "clawdbot-sbx-test",
      containerWorkdir: "/workspace",
      docker: {
        image: "clawdbot-sandbox:bookworm-slim",
        containerPrefix: "clawdbot-sbx-",
        workdir: "/workspace",
        readOnlyRoot: true,
        tmpfs: [],
        network: "none",
        user: "1000:1000",
        capDrop: ["ALL"],
        env: { LANG: "C.UTF-8" },
      },
      tools: {
        allow: ["bash"],
        deny: ["browser"],
      },
    };
    const tools = createClawdbotCodingTools({ sandbox });
    expect(tools.some((tool) => tool.name === "bash")).toBe(true);
    expect(tools.some((tool) => tool.name === "read")).toBe(false);
    expect(tools.some((tool) => tool.name === "browser")).toBe(false);
  });

  it("filters tools by agent tool policy even without sandbox", () => {
    const tools = createClawdbotCodingTools({
      config: { agent: { tools: { deny: ["browser"] } } },
    });
    expect(tools.some((tool) => tool.name === "bash")).toBe(true);
    expect(tools.some((tool) => tool.name === "browser")).toBe(false);
  });
});
