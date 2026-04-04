import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { describe, expect, it, afterEach } from "vitest";
import {
  formatComposioToolCheatSheetFromIndex,
  loadComposioToolCheatSheetMarkdown,
} from "./composio-cheat-sheet.js";

describe("formatComposioToolCheatSheetFromIndex", () => {
  it("renders markdown with tool table and gotchas", () => {
    const md = formatComposioToolCheatSheetFromIndex({
      generated_at: "2025-01-01T00:00:00.000Z",
      connected_apps: [
        {
          toolkit_slug: "gmail",
          toolkit_name: "Gmail",
          account_count: 2,
          tools: [
            {
              name: "GMAIL_FETCH_EMAILS",
              title: "Fetch emails",
              description_short: "List messages.",
              required_args: [],
              arg_hints: {
                label_ids: 'Use ["INBOX"]',
              },
            },
          ],
          recipes: {
            "Read recent emails": "GMAIL_FETCH_EMAILS",
          },
        },
      ],
    });

    expect(md).toContain("### Gmail (2 accounts connected)");
    expect(md).toContain("GMAIL_FETCH_EMAILS");
    expect(md).toContain("Read recent emails");
    expect(md).toContain("label_ids");
    expect(md).toContain("Composio MCP");
  });
});

describe("loadComposioToolCheatSheetMarkdown", () => {
  let tmp: string;

  afterEach(() => {
    if (tmp) {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("reads composio-tool-index.json from workspace dir", () => {
    tmp = path.join(
      os.tmpdir(),
      `dench-composio-index-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(tmp, { recursive: true });
    writeFileSync(
      path.join(tmp, "composio-tool-index.json"),
      JSON.stringify({
        generated_at: "2025-01-02T00:00:00.000Z",
        connected_apps: [
          {
            toolkit_slug: "slack",
            toolkit_name: "Slack",
            account_count: 1,
            tools: [
              {
                name: "SLACK_SEND_MESSAGE",
                title: "Send",
                description_short: "Send a message.",
                required_args: ["channel", "text"],
                arg_hints: {},
              },
            ],
            recipes: {},
          },
        ],
      }),
      "utf-8",
    );

    const md = loadComposioToolCheatSheetMarkdown(tmp);
    expect(md).toContain("Slack (1 account connected)");
    expect(md).toContain("SLACK_SEND_MESSAGE");
    expect(md).toContain("composio_resolve_tool");
  });

  it("only claims verified MCP availability when the status file says so", () => {
    tmp = path.join(
      os.tmpdir(),
      `dench-composio-status-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(tmp, { recursive: true });
    writeFileSync(
      path.join(tmp, "composio-tool-index.json"),
      JSON.stringify({
        generated_at: "2025-01-02T00:00:00.000Z",
        connected_apps: [
          {
            toolkit_slug: "gmail",
            toolkit_name: "Gmail",
            account_count: 1,
            tools: [
              {
                name: "GMAIL_FETCH_EMAILS",
                title: "Fetch emails",
                description_short: "List inbox messages.",
                required_args: [],
                arg_hints: {},
                default_args: { label_ids: ["INBOX"], max_results: 10 },
              },
            ],
            recipes: { "Read recent emails": "GMAIL_FETCH_EMAILS" },
          },
        ],
      }),
      "utf-8",
    );
    writeFileSync(
      path.join(tmp, "composio-mcp-status.json"),
      JSON.stringify({
        summary: {
          verified: false,
          message: "Composio MCP is configured and the gateway is reachable, but live agent visibility has not been verified yet.",
        },
      }),
      "utf-8",
    );

    const md = loadComposioToolCheatSheetMarkdown(tmp);
    expect(md).toContain("configured integration layer");
    expect(md).not.toContain("verified MCP tools available");
  });

  it("returns null when file is missing", () => {
    tmp = path.join(
      os.tmpdir(),
      `dench-composio-empty-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(tmp, { recursive: true });
    expect(loadComposioToolCheatSheetMarkdown(tmp)).toBeNull();
  });
});
