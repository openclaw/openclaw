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

async function withPostFixture(
  run: (fixture: {
    client: ReturnType<typeof createMattermostClient>;
    read: () => Promise<Post>;
    setFlags: (enabled: boolean) => void;
    wire: string[];
  }) => Promise<void>,
  options: {
    allowChannelMentions?: boolean;
    assertRequestCurrent?: () => void;
    onLookup?: () => void;
    lookupResponse?: { status: number; body: unknown };
  } = {},
) {
  let stored: Post | undefined;
  const wire: string[] = [];
  await withServer(
    (request, response) => {
      let raw = "";
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => {
        raw += chunk;
      });
      request.on("end", () => {
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
              is_pinned: false,
              has_reactions: false,
              props: { retained: "provider metadata" },
              file_ids: ["file-fixture"],
            };
          } else if (!stored) {
            throw new Error("post not created");
          } else if (request.method === "PUT" && route === "/api/v4/posts/post-fixture") {
            // Full UpdatePost preserves nil props/files but decodes omitted scalars to zero values.
            stored = {
              ...stored,
              message: input.message ?? "",
              is_pinned: input.is_pinned ?? false,
              has_reactions: input.has_reactions ?? false,
              props: input.props ?? stored.props,
              file_ids: input.file_ids ?? stored.file_ids,
            };
          } else if (request.method === "PUT" && route === "/api/v4/posts/post-fixture/patch") {
            // PatchPost applies mention suppression before Post.Patch replaces supplied properties.
            if (
              options.allowChannelMentions === false &&
              /\B@(channel|all|here)\b/i.test(input.message ?? "")
            ) {
              input.props = { ...input.props, mentionHighlightDisabled: true };
            }
            stored = { ...stored, ...input };
          } else if (request.method === "GET" && route === "/api/v4/posts/post-fixture") {
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
      });
    },
    async (baseUrl) => {
      await run({
        client: createMattermostClient({
          baseUrl,
          botToken: "synthetic-edit-token",
          allowPrivateNetwork: true,
          assertRequestCurrent: options.assertRequestCurrent,
        }),
        read: async () => {
          const response = await fetch(`${baseUrl}/api/v4/posts/post-fixture`);
          expect(response.ok).toBe(true);
          return postSchema.parse(await response.json());
        },
        setFlags: (enabled) => {
          if (!stored) {
            throw new Error("post not created");
          }
          stored = { ...stored, is_pinned: enabled, has_reactions: enabled };
        },
        wire,
      });
    },
  );
}

describe("Mattermost partial edits preserve provider-owned post state", () => {
  it.each([true, false])("preserves pin/reaction state %s on text edit", async (enabled) => {
    await withPostFixture(async ({ client, read, setFlags }) => {
      const warnings: string[] = [];
      const stream = createMattermostDraftStream({
        client,
        channelId: "channel-fixture",
        warn: (message) => warnings.push(message),
      });
      try {
        stream.update("Working");
        await stream.flush();
        setFlags(enabled);
        const before = await read();
        stream.update("Working with more detail");
        await stream.flush();
        expect(warnings).toEqual([]);
        expect(await read()).toEqual({ ...before, message: "Working with more detail" });
      } finally {
        await stream.stop();
      }
    });
  });

  it("preserves message and flags on props-only edit", async () => {
    await withPostFixture(async ({ client, read, setFlags }) => {
      const stream = createMattermostDraftStream({ client, channelId: "channel-fixture" });
      try {
        stream.update("Existing message");
        await stream.flush();
        setFlags(true);
        const before = await read();
        const props = { attachments: [{ text: "Completed" }] };
        await updateMattermostPost(client, before.id, { props });
        expect(await read()).toEqual({ ...before, props });
      } finally {
        await stream.stop();
      }
    });
  });

  it.each([true, false])(
    "preserves omitted props when channel mentions are allowed=%s",
    async (allowChannelMentions) => {
      await withPostFixture(
        async ({ client, read }) => {
          const stream = createMattermostDraftStream({ client, channelId: "channel-fixture" });
          try {
            stream.update("Working");
            await stream.flush();
            const before = await read();
            stream.update("Update for @channel");
            await stream.flush();
            expect(await read()).toEqual({
              ...before,
              message: "Update for @channel",
              props: {
                ...before.props,
                ...(!allowChannelMentions ? { mentionHighlightDisabled: true } : {}),
              },
            });
          } finally {
            await stream.stop();
          }
        },
        { allowChannelMentions },
      );
    },
  );

  it("replaces explicit props without looking up the old map", async () => {
    await withPostFixture(
      async ({ client, read, wire }) => {
        const stream = createMattermostDraftStream({ client, channelId: "channel-fixture" });
        try {
          stream.update("Working");
          await stream.flush();
          const before = await read();
          const start = wire.length;
          await updateMattermostPost(client, before.id, { message: "@channel", props: {} });
          expect(wire.slice(start)).toEqual(["PUT /api/v4/posts/post-fixture/patch"]);
          expect(await read()).toEqual({
            ...before,
            message: "@channel",
            props: { mentionHighlightDisabled: true },
          });
        } finally {
          await stream.stop();
        }
      },
      { allowChannelMentions: false },
    );
  });

  it("does not PUT after authority is revoked during a valid props lookup", async () => {
    const revoked = new Error("fixture edit authority revoked");
    let current = true;
    let revokeOnLookup = false;
    await withPostFixture(
      async ({ client, read, wire }) => {
        const stream = createMattermostDraftStream({ client, channelId: "channel-fixture" });
        try {
          stream.update("Working");
          await stream.flush();
          const before = await read();
          const start = wire.length;
          revokeOnLookup = true;
          await expect(
            updateMattermostPost(client, before.id, { message: "@channel" }),
          ).rejects.toMatchObject({
            message: revoked.message,
            cause: revoked,
          });
          expect(wire.slice(start)).toEqual(["GET /api/v4/posts/post-fixture"]);
          expect(await read()).toEqual(before);
        } finally {
          await stream.stop();
        }
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
        const stream = createMattermostDraftStream({ client, channelId: "channel-fixture" });
        try {
          stream.update("Working");
          await stream.flush();
          const start = wire.length;
          await expect(
            updateMattermostPost(client, "post-fixture", { message: "@channel" }),
          ).rejects.toThrow();
          expect(wire.slice(start)).toEqual(["GET /api/v4/posts/post-fixture"]);
        } finally {
          await stream.stop();
        }
      },
      { lookupResponse },
    );
  });
});
