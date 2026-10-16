import { withServer } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createMattermostClient, updateMattermostPost } from "./client.js";
import { createMattermostDraftStream } from "./draft-stream.js";

const postSchema = z.object({
  id: z.string(),
  channel_id: z.string(),
  message: z.string(),
  is_pinned: z.boolean(),
  has_reactions: z.boolean(),
  props: z.record(z.string(), z.unknown()),
  file_ids: z.array(z.string()),
});
const updateSchema = postSchema.partial();
type Post = z.infer<typeof postSchema>;
const postPath = "/api/v4/posts/post-fixture";

async function withPostFixture(
  run: (fixture: {
    client: ReturnType<typeof createMattermostClient>;
    read: () => Promise<Post>;
    wire: string[];
    stream: ReturnType<typeof createMattermostDraftStream>;
    warnings: string[];
  }) => Promise<void>,
  options: {
    assertRequestCurrent?: () => void;
    onLookup?: () => void;
    lookupResponse?: { status: number; body: unknown };
  } = {},
) {
  let stored: Post | undefined;
  const wire: string[] = [];
  await withServer(
    async (request, response) => {
      let raw = "";
      request.setEncoding("utf8");
      for await (const chunk of request) {
        raw += chunk;
      }
      const route = request.url ?? "";
      wire.push(`${request.method} ${route}`);
      response.setHeader("content-type", "application/json");
      try {
        const input = updateSchema.parse(raw ? JSON.parse(raw) : {});
        if (request.method === "POST" && route === "/api/v4/posts") {
          stored = {
            id: "post-fixture",
            channel_id: "channel-fixture",
            message: input.message ?? "",
            is_pinned: true,
            has_reactions: true,
            props: { retained: "provider metadata" },
            file_ids: ["file-fixture"],
          };
        } else if (!stored) {
          throw new Error("post not created");
        } else if (request.method === "PUT" && route === `${postPath}/patch`) {
          // PatchPost applies mention suppression before Post.Patch replaces supplied properties.
          if (/\B@(channel|all|here)\b/i.test(input.message ?? "")) {
            input.props = { ...input.props, mentionHighlightDisabled: true };
          }
          stored = { ...stored, ...input };
        } else if (request.method === "GET" && route === postPath) {
          options.onLookup?.();
          if (options.lookupResponse) {
            response.statusCode = options.lookupResponse.status;
            response.end(JSON.stringify(options.lookupResponse.body));
            return;
          }
        } else {
          throw new Error(`unexpected request ${request.method} ${route}`);
        }
        response.end(JSON.stringify(stored));
      } catch (error) {
        response.statusCode = 400;
        response.end(JSON.stringify({ message: String(error) }));
      }
    },
    async (baseUrl) => {
      const client = createMattermostClient({
        baseUrl,
        botToken: "synthetic-edit-token",
        allowPrivateNetwork: true,
        assertRequestCurrent: options.assertRequestCurrent,
      });
      const warnings: string[] = [];
      const stream = createMattermostDraftStream({
        client,
        channelId: "channel-fixture",
        warn: (message) => warnings.push(message),
      });
      try {
        stream.update("Working");
        await stream.flush();
        await run({
          client,
          read: async () => {
            const response = await fetch(`${baseUrl}${postPath}`);
            expect(response.ok).toBe(true);
            return postSchema.parse(await response.json());
          },
          wire,
          stream,
          warnings,
        });
      } finally {
        await stream.stop();
      }
    },
  );
}

describe("Mattermost partial edits preserve provider-owned post state", () => {
  it("preserves message and flags on props-only edit", async () => {
    await withPostFixture(async ({ client, read }) => {
      const before = await read();
      const props = { attachments: [{ text: "Completed" }] };
      await updateMattermostPost(client, before.id, { props });
      expect(await read()).toEqual({ ...before, props });
    });
  });

  it("preserves flags and omitted props when channel mentions are restricted", async () => {
    await withPostFixture(async ({ stream, warnings, read }) => {
      const before = await read();
      stream.update("Update for @channel");
      await stream.flush();
      expect(warnings).toEqual([]);
      expect(await read()).toEqual({
        ...before,
        message: "Update for @channel",
        props: { ...before.props, mentionHighlightDisabled: true },
      });
    });
  });

  it("replaces explicit props without looking up the old map", async () => {
    await withPostFixture(async ({ client, read, wire }) => {
      const before = await read();
      const start = wire.length;
      await updateMattermostPost(client, before.id, { message: "@channel", props: {} });
      expect(wire.slice(start)).toEqual([`PUT ${postPath}/patch`]);
      expect(await read()).toEqual({
        ...before,
        message: "@channel",
        props: { mentionHighlightDisabled: true },
      });
    });
  });

  it("does not PUT after authority is revoked during a valid props lookup", async () => {
    const revoked = new Error("fixture edit authority revoked");
    let current = true;
    let revokeOnLookup = false;
    await withPostFixture(
      async ({ client, read, wire }) => {
        const before = await read();
        const start = wire.length;
        revokeOnLookup = true;
        await expect(
          updateMattermostPost(client, before.id, { message: "@channel" }),
        ).rejects.toMatchObject({
          message: revoked.message,
          cause: revoked,
        });
        expect(wire.slice(start)).toEqual([`GET ${postPath}`]);
        expect(await read()).toEqual(before);
      },
      {
        assertRequestCurrent: () => {
          if (!current) {
            throw revoked;
          }
        },
        onLookup: () => {
          if (revokeOnLookup) {
            current = false;
          }
        },
      },
    );
  });

  it.each([
    { name: "failed", status: 503, body: { message: "Unavailable" } },
    { name: "malformed", status: 200, body: { props: {} } },
    { name: "wrong-ID", status: 200, body: { id: "another-post", props: {} } },
  ])("does not edit after a $name lookup", async (lookupResponse) => {
    await withPostFixture(
      async ({ client, wire }) => {
        const start = wire.length;
        await expect(
          updateMattermostPost(client, "post-fixture", { message: "@channel" }),
        ).rejects.toThrow();
        expect(wire.slice(start)).toEqual([`GET ${postPath}`]);
      },
      { lookupResponse },
    );
  });
});
