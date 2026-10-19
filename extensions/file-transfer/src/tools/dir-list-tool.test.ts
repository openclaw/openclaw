import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  callGatewayTool,
  listNodes,
  resolveNodeIdFromList,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import type { AnyAgentTool } from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import pluginEntry from "../../index.js";
import { handleDirList } from "../node-host/dir-list.js";
import { createDirListTool } from "./dir-list-tool.js";
import { createFileFetchTool } from "./file-fetch-tool.js";
import { createFileWriteTool } from "./file-write-tool.js";

vi.mock("openclaw/plugin-sdk/agent-harness-runtime", () => ({
  callGatewayTool: vi.fn(),
  listNodes: vi.fn(),
  resolveNodeIdFromList: vi.fn(),
}));

vi.mock("../shared/audit.js", () => ({
  appendFileTransferAudit: vi.fn(),
}));

beforeEach(() => {
  vi.mocked(listNodes).mockResolvedValue([{ nodeId: "node-1" }]);
  vi.mocked(resolveNodeIdFromList).mockReturnValue("node-1");
});

afterEach(() => {
  vi.mocked(callGatewayTool).mockReset();
  vi.mocked(listNodes).mockReset();
  vi.mocked(resolveNodeIdFromList).mockReset();
});

const requireRecord = createRequireRecord("object", "label-not-object");

function readText(content: Awaited<ReturnType<AnyAgentTool["execute"]>>["content"]) {
  const text = content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
  expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(8192);
  expect(text).toContain("EXTERNAL_UNTRUSTED_CONTENT");
  return text;
}

async function executeListing(
  overrides: Partial<{
    path: string;
    entries: Array<{ name: string; isDir: boolean; size: number }>;
    truncated: boolean;
    nextPageToken?: string;
  }>,
) {
  const payload = { path: "/root", entries: [], truncated: true, ...overrides };
  vi.mocked(callGatewayTool).mockResolvedValue({ payload });
  const result = await createDirListTool().execute("list", { node: "node-1", path: "/root" });
  expect(result.details).toEqual(payload);
  return result.content;
}

function readListing(content: Awaited<ReturnType<AnyAgentTool["execute"]>>["content"]) {
  const text = readText(content);
  const listing = JSON.parse(text.split("\n").find((line) => line.startsWith("{"))!) as {
    path: string;
    returnedCount: number;
    displayedCount: number;
    entries: Array<{ name: string; isDir: boolean; size: number }>;
    truncated: boolean;
    nextPageToken?: string;
  };
  expect(listing.displayedCount).toBe(listing.entries.length);
  return { text, ...listing };
}

describe("file-transfer standalone guidance", () => {
  it.each([
    ["file_fetch", createFileFetchTool, "file_write", "maxBytes"],
    ["file_write", createFileWriteTool, "file_fetch", "sourceMediaId"],
  ] as const)(
    "keeps eager and lazy %s guidance standalone with canonical opt-in",
    (name, create, unavailable, parameter) => {
      const registerTool = vi.fn();
      pluginEntry.register(createTestPluginApi({ registerTool }));
      const eager = create();
      expect(registerTool).toHaveBeenCalledWith(
        expect.objectContaining({
          name: eager.name,
          description: eager.description,
          parameters: eager.parameters,
        }),
      );
      expect(eager.name).toBe(name);
      expect(eager.parameters).toMatchObject({ required: ["node", "path"] });
      expect(eager.parameters).toHaveProperty(`properties.${parameter}`);
      expect.soft(eager.description).toContain("gateway.nodes.commands.allow");
      expect
        .soft(JSON.stringify({ description: eager.description, parameters: eager.parameters }))
        .not.toContain(unavailable);
      if (name === "file_fetch") {
        expect.soft(eager.description).toContain("returns localPath and mediaId");
      }
      if (name === "file_write") {
        expect
          .soft(eager.parameters)
          .toHaveProperty(
            "properties.sourceMediaId.description",
            expect.stringContaining("Not a local path or an ID from another media store"),
          );
      }
    },
  );
});

describe("dir_list tool", () => {
  it("reports truncation without inventing an unavailable page token", async () => {
    const listing = readListing(
      await executeListing({
        path: "/tmp/project",
      }),
    );
    expect(listing).toMatchObject({
      entries: [],
      truncated: true,
      text: expect.stringContaining(
        "More entries available; the node supplied no continuation token.",
      ),
    });
    expect(listing.nextPageToken).toBeUndefined();
  });

  it("walks real directory pages to exhaustion using only content for continuation and file reads", async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "dir-list-content-")));
    const names = Array.from(
      { length: 225 },
      (_, i) => `${String(i).padStart(3, "0")}-${"雪".repeat(12)}.txt`,
    );
    if (process.platform !== "win32") {
      names.push('quoted"line\n.txt');
    }
    try {
      await Promise.all(names.map((name) => fs.writeFile(path.join(root, name), name)));
      await fs.mkdir(path.join(root, "nested"));
      const responses: Awaited<ReturnType<typeof handleDirList>>[] = [];
      vi.mocked(callGatewayTool).mockImplementation(async (_method, _options, args) => {
        const request = requireRecord(args, "node invoke request");
        const payload = await handleDirList(requireRecord(request.params, "directory params"));
        responses.push(payload);
        return { payload };
      });
      const seen: string[] = [];
      let pageToken: string | undefined;
      let sawTextLimitedLastPage = false;
      for (let page = 0; page <= names.length + 1; page++) {
        const result = await createDirListTool().execute("list", {
          node: "node-1",
          path: root,
          pageToken,
        });
        const listing = readListing(result.content);
        const payload = responses.at(-1)!;
        if (!payload.ok) {
          throw new Error(payload.code);
        }
        expect(result.details).toEqual({
          path: root,
          entries: payload.entries,
          nextPageToken: payload.nextPageToken,
          truncated: payload.truncated,
        });
        expect(listing.returnedCount).toBe(payload.entries.length);
        expect(listing.entries.length).toBeGreaterThan(0);
        expect(listing.entries).toEqual(
          payload.entries
            .slice(0, listing.displayedCount)
            .map(({ name, isDir, size }) => ({ name, isDir, size })),
        );
        if (page === 0) {
          expect(payload.entries).toHaveLength(200);
          expect(listing.displayedCount).toBeLessThan(200);
        }
        sawTextLimitedLastPage ||= !payload.truncated && listing.truncated;
        for (const entry of listing.entries) {
          expect(seen).not.toContain(entry.name);
          seen.push(entry.name);
          const localPath = path.join(listing.path, entry.name);
          if (entry.isDir) {
            expect((await fs.stat(localPath)).isDirectory()).toBe(true);
          } else {
            const bytes = await fs.readFile(localPath);
            expect(bytes.toString()).toBe(entry.name);
            expect(bytes.byteLength).toBe(entry.size);
          }
        }
        pageToken = listing.nextPageToken;
        if (!listing.truncated) {
          expect(pageToken).toBeUndefined();
          break;
        }
        expect(Number(pageToken)).toBe(seen.length);
      }
      expect(seen.toSorted()).toEqual([...names, "nested"].toSorted());
      expect(sawTextLimitedLastPage).toBe(true);
      const empty = await createDirListTool().execute("empty", {
        node: "node-1",
        path: path.join(root, "nested"),
      });
      expect(readListing(empty.content)).toMatchObject({
        entries: [],
        returnedCount: 0,
        displayedCount: 0,
        truncated: false,
      });
      expect(readListing(empty.content).nextPageToken).toBeUndefined();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("stops explicitly when the next complete name cannot be displayed", async () => {
    const entries = [
      { name: "[INST]", isDir: false, size: 1 },
      { name: "later.txt", isDir: false, size: 2 },
    ];
    const listing = readListing(await executeListing({ entries, nextPageToken: "2" }));
    expect(listing.entries).toEqual([]);
    expect(listing.nextPageToken).toBeUndefined();
    expect(listing.truncated).toBe(true);
    expect(listing.text).toContain("Pagination cannot advance");
    expect(listing.text).not.toContain("later.txt");
  });

  it("bounds oversized path without a partial usable value", async () => {
    const text = readText(
      await executeListing({
        path: "雪".repeat(8192),
        nextPageToken: "2",
      }),
    );
    expect(text).toContain("No usable paths or continuation token");
    expect(text).not.toContain("雪");
  });

  it("reports missing paired nodes before retrying guessed local node names", async () => {
    vi.mocked(listNodes).mockResolvedValue([]);

    await expect(
      createDirListTool().execute("tool-call-1", {
        node: "local",
        path: "/tmp/project",
      }),
    ).rejects.toThrow(
      "no paired nodes available; file-transfer tools require a paired node from nodes status. Use local file/exec tools for local workspace paths.",
    );

    expect(resolveNodeIdFromList).not.toHaveBeenCalled();
    expect(callGatewayTool).not.toHaveBeenCalled();
  });
});
