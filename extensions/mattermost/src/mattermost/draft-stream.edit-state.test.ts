import { withServer } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it, vi } from "vitest";
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

async function withPostServer(
  run: (context: {
    client: ReturnType<typeof createMattermostClient>;
    readPost: () => Promise<Post>;
    setUserFlags: (pinned: boolean, reactions: boolean) => void;
    paths: string[];
  }) => Promise<void>,
  allowChannelMentions = true,
) {
  let stored: Post | undefined;
  const paths: string[] = [];
  await withServer(
    (request, response) => {
      let raw = "";
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => {
        raw += chunk;
      });
      request.on("end", () => {
        const route = request.url ?? "";
        paths.push(`${request.method} ${route}`);
        response.setHeader("content-type", "application/json");
        try {
          const input = updateSchema.parse(raw ? JSON.parse(raw) : {});
          if (request.method === "POST" && route === "/api/v4/posts") {
            stored = postSchema.parse({
              ...input,
              id: "post-fixture",
              is_pinned: false,
              has_reactions: false,
              props: { retained: "provider metadata" },
              file_ids: ["file-fixture"],
            });
          } else if (!stored) {
            throw new Error("Post has not been created");
          } else if (request.method === "PUT" && route === "/api/v4/posts/post-fixture") {
            // Mattermost's full UpdatePost decodes omitted scalar fields to zero
            // values. The REST adapter separately preserves nil props and files.
            stored = {
              ...stored,
              message: input.message ?? "",
              is_pinned: input.is_pinned ?? false,
              has_reactions: input.has_reactions ?? false,
              props: input.props ?? stored.props,
              file_ids: input.file_ids ?? stored.file_ids,
            };
            if (!allowChannelMentions && /\B@(channel|all|here)\b/i.test(stored.message)) {
              stored.props = { ...stored.props, mentionHighlightDisabled: true };
            }
          } else if (request.method === "PUT" && route === "/api/v4/posts/post-fixture/patch") {
            // The provider's PostPatch applies only supplied fields to the stored
            // post before UpdatePost. It is a PUT endpoint, not an HTTP PATCH.
            // Its mention restriction initializes omitted patch props before
            // Post.Patch replaces the stored props with that map.
            if (!allowChannelMentions && /\B@(channel|all|here)\b/i.test(input.message ?? "")) {
              input.props = { ...input.props, mentionHighlightDisabled: true };
            }
            stored = { ...stored, ...input };
          } else if (request.method !== "GET" || route !== "/api/v4/posts/post-fixture") {
            throw new Error(`Unexpected fixture request: ${request.method} ${route}`);
          }
          response.end(JSON.stringify(stored));
        } catch (error) {
          response.statusCode = 400;
          response.end(JSON.stringify({ message: String(error) }));
        }
      });
    },
    async (baseUrl) => {
      const client = createMattermostClient({
        baseUrl,
        botToken: "loopback-fixture",
        allowPrivateNetwork: true,
      });
      await run({
        client,
        paths,
        readPost: async () => {
          const response = await fetch(`${baseUrl}/api/v4/posts/post-fixture`);
          expect(response.ok).toBe(true);
          return postSchema.parse(await response.json());
        },
        setUserFlags: (pinned, reactions) => {
          if (!stored) {
            throw new Error("User action requires a created post");
          }
          stored = { ...stored, is_pinned: pinned, has_reactions: reactions };
        },
      });
    },
  );
}

describe("Mattermost partial edits preserve provider-owned post state", () => {
  it.each([true, false])(
    "preserves user pin and reaction flags set to %s across draft updates",
    async (enabled) => {
      await withPostServer(async ({ client, readPost, setUserFlags, paths }) => {
        const warnings: string[] = [];
        const stream = createMattermostDraftStream({
          client,
          channelId: "channel-fixture",
          warn: (warning) => warnings.push(warning),
        });
        try {
          stream.update("Working");
          await stream.flush();
          expect(stream.postId()).toBe("post-fixture");
          expect(await readPost()).toMatchObject({
            message: "Working",
            is_pinned: false,
            has_reactions: false,
          });
          setUserFlags(enabled, enabled);
          const before = await readPost();

          stream.update("Working with more detail");
          await stream.flush();
          const after = await readPost();
          console.info("MATTERMOST_EDIT_PROOF", JSON.stringify({ before, after, paths }));
          expect(warnings).toEqual([]);
          expect(after).toEqual({ ...before, message: "Working with more detail" });
          expect(stream.postId()).toBe(before.id);
          expect(paths.filter((entry) => entry === "POST /api/v4/posts")).toHaveLength(1);
        } finally {
          await stream.stop();
        }
      });
    },
  );

  it("preserves omitted message and flags when updating only post props", async () => {
    await withPostServer(async ({ client, readPost, setUserFlags }) => {
      const stream = createMattermostDraftStream({ client, channelId: "channel-fixture" });
      try {
        stream.update("Existing message");
        await stream.flush();
        setUserFlags(true, true);
        const before = await readPost();
        const props = { attachments: [{ text: "Completed" }] };
        await updateMattermostPost(client, before.id, { props });
        expect(await readPost()).toEqual({ ...before, props });
      } finally {
        await stream.stop();
      }
    });
  });

  it.each([true, false])(
    "preserves existing props when channel mentions are allowed=%s",
    async (allowChannelMentions) => {
      await withPostServer(async ({ client, readPost, paths }) => {
        const warnings: string[] = [];
        const stream = createMattermostDraftStream({
          client,
          channelId: "channel-fixture",
          warn: (warning) => warnings.push(warning),
        });
        try {
          stream.update("Working");
          await stream.flush();
          const before = await readPost();
          stream.update("Update for @channel");
          await stream.flush();
          const after = await readPost();
          console.info(
            "MATTERMOST_MENTION_PROOF",
            JSON.stringify({ allowChannelMentions, before, after, paths }),
          );
          expect(warnings).toEqual([]);
          expect(after).toEqual({
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
      }, allowChannelMentions);
    },
  );

  it.each(["@HERE", "Hello @all", "(@channel)"])(
    "retains only the current props when editing %s",
    async (message) => {
      const current = {
        id: "post-fixture",
        props: { attachments: [{ text: "Retained card" }], external: "retained" },
        is_pinned: true,
        has_reactions: true,
      };
      const fetchImpl = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(Response.json(current))
        .mockResolvedValueOnce(Response.json({ ...current, message }));
      const client = createMattermostClient({
        baseUrl: "https://mattermost.example.com",
        botToken: "fixture-token",
        fetchImpl,
      });
      await updateMattermostPost(client, current.id, { message });
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      expect(fetchImpl.mock.calls[0]?.[0]).toBe(
        "https://mattermost.example.com/api/v4/posts/post-fixture",
      );
      expect(fetchImpl.mock.calls[1]?.[1]?.body).toBe(
        JSON.stringify({ id: current.id, message, props: current.props }),
      );
    },
  );

  it("keeps explicit replacement props without a read-modify-write", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ id: "post-fixture" }));
    const client = createMattermostClient({
      baseUrl: "https://mattermost.example.com",
      botToken: "fixture-token",
      fetchImpl,
    });
    await updateMattermostPost(client, "post-fixture", { message: "@channel", props: {} });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]?.[1]?.body).toBe(
      JSON.stringify({ id: "post-fixture", message: "@channel", props: {} }),
    );
  });

  it.each([
    {
      name: "failed lookup",
      response: () => Response.json({ message: "Unavailable" }, { status: 503 }),
    },
    { name: "malformed lookup", response: () => Response.json({ props: {} }) },
    { name: "different post", response: () => Response.json({ id: "other-post", props: {} }) },
  ])("does not edit after a $name", async ({ response }) => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => response());
    const client = createMattermostClient({
      baseUrl: "https://mattermost.example.com",
      botToken: "fixture-token",
      fetchImpl,
    });
    await expect(
      updateMattermostPost(client, "post-fixture", { message: "@channel" }),
    ).rejects.toThrow();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]?.[1]?.method).not.toBe("PUT");
  });
});
