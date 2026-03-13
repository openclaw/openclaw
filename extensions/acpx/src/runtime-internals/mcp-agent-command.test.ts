import { afterEach, describe, expect, it, vi } from "vitest";
import { ACPX_CODEX_ACP_BUNDLED_BIN } from "../config.js";

const { spawnAndCollectMock } = vi.hoisted(() => ({
  spawnAndCollectMock: vi.fn(),
}));

vi.mock("./process.js", () => ({
  spawnAndCollect: spawnAndCollectMock,
}));

import {
  formatRawAgentCommandForCli,
  resolveAcpxAgentCommand,
} from "./mcp-agent-command.js";

describe("resolveAcpxAgentCommand", () => {
  afterEach(() => {
    spawnAndCollectMock.mockReset();
  });

  it("prefers the bundled plugin-local codex-acp command by default", async () => {
    spawnAndCollectMock.mockResolvedValueOnce({
      stdout: JSON.stringify({ agents: {} }),
      stderr: "",
      code: 0,
      error: null,
    });

    await expect(
      resolveAcpxAgentCommand({
        acpxCommand: "/plugin/node_modules/.bin/acpx",
        cwd: "/workspace",
        agent: "codex",
      }),
    ).resolves.toBe(ACPX_CODEX_ACP_BUNDLED_BIN);
  });

  it("honors explicit acpx config overrides ahead of bundled defaults", async () => {
    spawnAndCollectMock.mockResolvedValueOnce({
      stdout: JSON.stringify({
        agents: {
          codex: {
            command: "npx custom-codex-acp",
          },
        },
      }),
      stderr: "",
      code: 0,
      error: null,
    });

    await expect(
      resolveAcpxAgentCommand({
        acpxCommand: "/plugin/node_modules/.bin/acpx",
        cwd: "/workspace",
        agent: "codex",
      }),
    ).resolves.toBe("npx custom-codex-acp");
  });
});

describe("formatRawAgentCommandForCli", () => {
  it("quotes spaced path-like commands without arguments", () => {
    expect(formatRawAgentCommandForCli("/opt/My Agent/codex-acp")).toBe(
      '"/opt/My Agent/codex-acp"',
    );
  });

  it("preserves trailing args for spaced path-like commands", () => {
    expect(formatRawAgentCommandForCli("/opt/My Agent/codex-acp --model gpt-5")).toBe(
      '"/opt/My Agent/codex-acp" --model gpt-5',
    );
  });
});
