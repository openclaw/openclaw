import { withServer } from "openclaw/plugin-sdk/test-env";
import { expect, it, vi } from "vitest";
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
type Post = z.infer<typeof postSchema>;
const postPath = "/api/v4/posts/post-fixture";

async function withPostFixture(
  run: (fixture: {
    client: ReturnType<typeof createMattermostClient>;
    before: Post;
    read: () => Post;
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
        const input = postSchema.partial().parse(raw ? JSON.parse(raw) : {});
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
      const warn = (message: string) => warnings.push(message);
      const stream = createMattermostDraftStream({ client, channelId: "channel-fixture", warn });
      try {
        stream.update("Working");
        await stream.flush();
        wire.length = 0;
        await run({
          client,
          before: postSchema.parse(stored),
          read: () => postSchema.parse(stored),
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

it("preserves message and flags on props-only edit", async () => {
  await withPostFixture(async ({ client, before, read }) => {
    const props = { attachments: [{ text: "Completed" }] };
    await updateMattermostPost(client, before.id, { props });
    expect(read()).toEqual({ ...before, props });
  });
});

it("preserves flags and omitted props when channel mentions are restricted", async () => {
  await withPostFixture(async ({ stream, warnings, before, read }) => {
    stream.update("Update for @channel");
    await stream.flush();
    expect(warnings).toEqual([]);
    expect(read()).toEqual({
      ...before,
      message: "Update for @channel",
      props: { ...before.props, mentionHighlightDisabled: true },
    });
  });
});

it("replaces explicit props without looking up the old map", async () => {
  await withPostFixture(async ({ client, before, read, wire }) => {
    await updateMattermostPost(client, before.id, { message: "@channel", props: {} });
    expect(wire).toEqual([`PUT ${postPath}/patch`]);
    expect(read()).toEqual({
      ...before,
      message: "@channel",
      props: { mentionHighlightDisabled: true },
    });
  });
});

it("does not PUT after authority is revoked during a valid props lookup", async () => {
  const revoked = new Error("fixture edit authority revoked");
  const assertRequestCurrent = vi.fn();
  const deny = () => {
    throw revoked;
  };
  await withPostFixture(
    async ({ client, before, read, wire }) => {
      const edit = updateMattermostPost(client, before.id, { message: "@channel" });
      await expect(edit).rejects.toMatchObject({ message: revoked.message, cause: revoked });
      expect(wire).toEqual([`GET ${postPath}`]);
      expect(read()).toEqual(before);
    },
    {
      assertRequestCurrent,
      onLookup: () => assertRequestCurrent.mockImplementation(deny),
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
      const edit = updateMattermostPost(client, "post-fixture", { message: "@channel" });
      await expect(edit).rejects.toThrow();
      expect(wire).toEqual([`GET ${postPath}`]);
    },
    { lookupResponse },
  );
});
