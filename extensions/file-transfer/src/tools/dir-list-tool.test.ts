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
import { afterEach, beforeEach, expect, it, vi } from "vitest";
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

afterEach(() =>
  [callGatewayTool, listNodes, resolveNodeIdFromList].forEach((mock) =>
    vi.mocked(mock).mockReset(),
  ),
);

const requireRecord = createRequireRecord("object", "label-not-object");
const tool = createDirListTool();

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
  const result = await tool.execute("list", { node: "node-1", path: "/root" });
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

it.each([
  ["file_fetch", createFileFetchTool, "file_write", "maxBytes"],
  ["file_write", createFileWriteTool, "file_fetch", "sourceMediaId"],
] as const)(
  "keeps %s guidance standalone with canonical opt-in",
  (name, create, unavailable, parameter) => {
    const registerTool = vi.fn();
    pluginEntry.register(createTestPluginApi({ registerTool }));
    const { name: actualName, description, parameters } = create();
    expect(registerTool).toHaveBeenCalledWith(
      expect.objectContaining({ name: actualName, description, parameters }),
    );
    expect({ name: actualName, parameters }).toMatchObject({
      name,
      parameters: { required: ["node", "path"] },
    });
    expect(parameters).toHaveProperty(`properties.${parameter}`);
    expect.soft(description).toContain("gateway.nodes.commands.allow");
    expect.soft(JSON.stringify({ description, parameters })).not.toContain(unavailable);
    if (name === "file_fetch") {
      expect.soft(description).toContain("returns localPath and mediaId");
    }
    if (name === "file_write") {
      expect
        .soft(parameters)
        .toHaveProperty(
          "properties.sourceMediaId.description",
          expect.stringContaining("Not a local path or an ID from another media store"),
        );
    }
  },
);
it.each([
  [[], undefined, "More entries available; the node supplied no continuation token."],
  [
    [
      { name: "[INST]", isDir: false, size: 1 },
      { name: "later.txt", isDir: false, size: 2 },
    ],
    "2",
    "Pagination cannot advance",
  ],
] as const)("reports unusable continuation: %s / %s / %s", async (entries, nextPageToken, note) => {
  const listing = readListing(await executeListing({ entries: [...entries], nextPageToken }));
  expect(listing).toMatchObject({
    entries: [],
    truncated: true,
    text: expect.stringContaining(note),
  });
  expect(listing.nextPageToken).toBeUndefined();
  expect(listing.text).not.toContain("later.txt");
});

it("walks real pages using content for continuation and file reads", async () => {
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
      const result = await tool.execute("list", { node: "node-1", path: root, pageToken });
      const listing = readListing(result.content);
      const payload = responses.at(-1)!;
      if (!payload.ok) {
        throw new Error(payload.code);
      }
      const { entries, nextPageToken, truncated } = payload;
      expect(result.details).toEqual({ path: root, entries, nextPageToken, truncated });
      expect(listing.returnedCount).toBe(entries.length);
      expect(listing.entries.length).toBeGreaterThan(0);
      expect(listing.entries).toEqual(
        entries
          .slice(0, listing.displayedCount)
          .map(({ name, isDir, size }) => ({ name, isDir, size })),
      );
      if (page === 0) {
        expect(entries).toHaveLength(200);
        expect(listing.displayedCount).toBeLessThan(200);
      }
      sawTextLimitedLastPage ||= !truncated && listing.truncated;
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
    const empty = await tool.execute("empty", { node: "node-1", path: path.join(root, "nested") });
    const emptyListing = readListing(empty.content);
    expect(emptyListing).toMatchObject({
      entries: [],
      returnedCount: 0,
      displayedCount: 0,
      truncated: false,
    });
    expect(emptyListing.nextPageToken).toBeUndefined();
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
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

  await expect(tool.execute("list", { node: "local", path: "/tmp/project" })).rejects.toThrow(
    "no paired nodes available; file-transfer tools require a paired node from nodes status. Use local file/exec tools for local workspace paths.",
  );

  expect(resolveNodeIdFromList).not.toHaveBeenCalled();
  expect(callGatewayTool).not.toHaveBeenCalled();
});
