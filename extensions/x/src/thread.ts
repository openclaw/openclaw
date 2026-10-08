import type { XApiClient, XPage, XPost, XUser } from "./api.js";
import { XBudgetExceededError } from "./spend.js";

function comparePosts(a: XPost, b: XPost): number {
  return BigInt(a.id) < BigInt(b.id) ? -1 : BigInt(a.id) > BigInt(b.id) ? 1 : 0;
}

export async function assembleXThread(options: {
  api: XApiClient;
  mention: XPost;
  maxPosts?: number;
  users?: XUser[];
  signal?: AbortSignal;
}): Promise<{ bodyForAgent: string; label: string; posts: XPost[]; users: XUser[] }> {
  const maxPosts = Math.max(2, Math.floor(options.maxPosts ?? 50));
  const posts = new Map<string, XPost>([[options.mention.id, options.mention]]);
  const users = new Map((options.users ?? []).map((user) => [user.id, user]));
  const fetched = new Set<string>();
  const merge = (page: XPage) => {
    for (const post of [...page.includes.tweets, ...page.data]) {
      posts.set(post.id, post);
    }
    for (const user of page.includes.users) {
      users.set(user.id, user);
    }
  };
  async function fetchPosts(ids: string[]) {
    const pending = [...new Set(ids)].filter((id) => !fetched.has(id) && !posts.has(id));
    for (let offset = 0; offset < pending.length; offset += 100) {
      const batch = pending.slice(offset, offset + 100);
      batch.forEach((id) => fetched.add(id));
      merge(await options.api.getPosts(batch, options.signal));
    }
  }

  let budgetTruncated = false;
  try {
    let nextToken: string | undefined;
    const seenTokens = new Set<string>();
    do {
      const page = await options.api.searchConversation({
        conversationId: options.mention.conversation_id,
        maxPosts: maxPosts - posts.size,
        nextToken,
        signal: options.signal,
      });
      merge(page);
      nextToken = page.meta.next_token;
      if (nextToken && seenTokens.has(nextToken)) {
        throw new Error("X thread search pagination repeated a token");
      }
      if (nextToken) {
        seenTokens.add(nextToken);
      }
    } while (nextToken && posts.size < maxPosts);

    if (!users.has(options.mention.author_id)) {
      merge(await options.api.getPosts([options.mention.id], options.signal));
    }
    await fetchPosts([options.mention.conversation_id]);
    let ancestor: XPost | undefined = options.mention;
    // The root is fetched explicitly; bound ancestor reads to the configured context budget.
    for (let depth = 0; ancestor && depth < maxPosts; depth++) {
      const parentId = ancestor.referenced_tweets?.find(
        (reference) => reference.type === "replied_to",
      )?.id;
      if (!parentId || parentId === ancestor.id) {
        break;
      }
      await fetchPosts([parentId]);
      ancestor = posts.get(parentId);
    }
    await fetchPosts(
      [...posts.values()].flatMap(
        (post) =>
          post.referenced_tweets
            ?.filter((reference) => reference.type === "quoted")
            .map((reference) => reference.id) ?? [],
      ),
    );
  } catch (error) {
    if (!(error instanceof XBudgetExceededError)) {
      throw error;
    }
    budgetTruncated = true;
  }

  const root = posts.get(options.mention.conversation_id);
  const retained = new Map<string, XPost>();
  if (root) {
    retained.set(root.id, root);
  }
  retained.set(options.mention.id, options.mention);
  for (const post of [...posts.values()].toSorted(comparePosts).toReversed()) {
    if (retained.size >= maxPosts) {
      break;
    }
    retained.set(post.id, post);
  }
  const selected = [...retained.values()].toSorted(comparePosts);
  const handle = (post: XPost) => `@${users.get(post.author_id)?.username ?? post.author_id}`;
  const quotedIds = new Set(
    [...posts.values()].flatMap(
      (post) =>
        post.referenced_tweets
          ?.filter((reference) => reference.type === "quoted")
          .map((reference) => reference.id) ?? [],
    ),
  );
  const lines = selected.map((post) => {
    const marker =
      post.id === options.mention.id
        ? " [triggering mention]"
        : quotedIds.has(post.id)
          ? " [quoted post]"
          : "";
    return `${handle(post)} (${post.created_at ?? "time unavailable"})${marker}: ${post.text}`;
  });
  const labelPost = root ?? selected[0] ?? options.mention;
  return {
    bodyForAgent: `X thread context (oldest to newest):\n${lines
      .map((line) =>
        line
          .split(/\r\n|[\r\n\u2028\u2029]/)
          .map((part) => `> ${part}`)
          .join("\n"),
      )
      .join(
        "\n",
      )}${budgetTruncated ? "\n[thread context truncated by budget]" : ""}\n\nReply to the triggering mention.`,
    label: `${handle(labelPost)}: ${labelPost.text.replace(/\s+/g, " ").slice(0, 80)}`,
    posts: selected,
    users: [...users.values()],
  };
}
