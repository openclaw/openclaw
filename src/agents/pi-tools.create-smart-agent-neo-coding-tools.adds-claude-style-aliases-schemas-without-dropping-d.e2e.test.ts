import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import "./test-helpers/fast-coding-tools.js";
import { createSmartAgentNeoCodingTools } from "./pi-tools.js";
import { createHostSandboxFsBridge } from "./test-helpers/host-sandbox-fs-bridge.js";

const defaultTools = createSmartAgentNeoCodingTools();

describe("createSmartAgentNeoCodingTools", () => {
  it("keeps read tool image metadata intact", async () => {
    const readTool = defaultTools.find((tool) => tool.name === "read");
    expect(readTool).toBeDefined();

    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "smart-agent-neo-read-"));
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

      expect(result?.content?.some((block) => block.type === "image")).toBe(true);
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
    const tools = createSmartAgentNeoCodingTools();
    const readTool = tools.find((tool) => tool.name === "read");
    expect(readTool).toBeDefined();

    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "smart-agent-neo-read-"));
    try {
      const textPath = path.join(tmpDir, "sample.txt");
      const contents = "Hello from smart-agent-neo read tool.";
      await fs.writeFile(textPath, contents, "utf8");

      const result = await readTool?.execute("tool-2", {
        path: textPath,
      });

      expect(result?.content?.some((block) => block.type === "image")).toBe(false);
      const textBlocks = result?.content?.filter((block) => block.type === "text") as
        | Array<{ text?: string }>
        | undefined;
      expect(textBlocks?.length ?? 0).toBeGreaterThan(0);
      const combinedText = textBlocks?.map((block) => block.text ?? "").join("\n");
      expect(combinedText).toContain(contents);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
  it("filters tools by sandbox policy", () => {
    const sandboxDir = path.join(os.tmpdir(), "neobot-sandbox");
    const sandbox = {
      enabled: true,
      sessionKey: "sandbox:test",
      workspaceDir: sandboxDir,
      agentWorkspaceDir: path.join(os.tmpdir(), "neobot-workspace"),
      workspaceAccess: "none",
      containerName: "smart-agent-neo-sbx-test",
      containerWorkdir: "/workspace",
      fsBridge: createHostSandboxFsBridge(sandboxDir),
      docker: {
        image: "smart-agent-neo-sandbox:bookworm-slim",
        containerPrefix: "smart-agent-neo-sbx-",
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
      browserAllowHostControl: false,
    };
    const tools = createSmartAgentNeoCodingTools({ sandbox });
    expect(tools.some((tool) => tool.name === "exec")).toBe(true);
    expect(tools.some((tool) => tool.name === "read")).toBe(false);
    expect(tools.some((tool) => tool.name === "browser")).toBe(false);
  });
  it("hard-disables write/edit when sandbox workspaceAccess is ro", () => {
    const sandboxDir = path.join(os.tmpdir(), "neobot-sandbox");
    const sandbox = {
      enabled: true,
      sessionKey: "sandbox:test",
      workspaceDir: sandboxDir,
      agentWorkspaceDir: path.join(os.tmpdir(), "neobot-workspace"),
      workspaceAccess: "ro",
      containerName: "smart-agent-neo-sbx-test",
      containerWorkdir: "/workspace",
      fsBridge: createHostSandboxFsBridge(sandboxDir),
      docker: {
        image: "smart-agent-neo-sandbox:bookworm-slim",
        containerPrefix: "smart-agent-neo-sbx-",
        workdir: "/workspace",
        readOnlyRoot: true,
        tmpfs: [],
        network: "none",
        user: "1000:1000",
        capDrop: ["ALL"],
        env: { LANG: "C.UTF-8" },
      },
      tools: {
        allow: ["read", "write", "edit"],
        deny: [],
      },
      browserAllowHostControl: false,
    };
    const tools = createSmartAgentNeoCodingTools({ sandbox });
    expect(tools.some((tool) => tool.name === "read")).toBe(true);
    expect(tools.some((tool) => tool.name === "write")).toBe(false);
    expect(tools.some((tool) => tool.name === "edit")).toBe(false);
  });
  it("filters tools by agent tool policy even without sandbox", () => {
    const tools = createSmartAgentNeoCodingTools({
      config: { tools: { deny: ["browser"] } },
    });
    expect(tools.some((tool) => tool.name === "exec")).toBe(true);
    expect(tools.some((tool) => tool.name === "browser")).toBe(false);
  });
});
