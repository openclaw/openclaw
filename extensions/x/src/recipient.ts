import type { XApiClient, XPost, XPostEnvelope, XUser } from "./api.js";

export async function resolveXRecipient(options: {
  api: XApiClient;
  post: XPost | string;
  users?: XUser[];
  userId: string;
  signal?: AbortSignal;
}): Promise<XPostEnvelope | undefined> {
  let post = typeof options.post === "string" ? undefined : options.post;
  if (post?.author_id === options.userId) {
    return undefined;
  }
  let users = options.users ?? [];
  let included: XPost[] = [];
  if (post?.entities?.mentions === undefined) {
    const postId = typeof options.post === "string" ? options.post : options.post.id;
    const page = await options.api.getPosts([postId], options.signal);
    post = page.data.find((candidate) => candidate.id === postId);
    users = [...users, ...page.includes.users];
    included = page.includes.tweets;
  }
  if (!post || post.author_id === options.userId) {
    return undefined;
  }
  const mentions = post.entities?.mentions ?? [];
  if (mentions.some((mention) => mention.id === options.userId)) {
    return { post, users };
  }
  const unresolvedHandles = new Set(
    mentions.filter((mention) => !mention.id).map((mention) => mention.username.toLowerCase()),
  );
  for (const username of unresolvedHandles) {
    const recipient = await options.api.getUserByUsername(username, options.signal);
    if (recipient.id === options.userId) {
      return { post, users };
    }
  }
  const quoteIds =
    post.referenced_tweets
      ?.filter((reference) => reference.type === "quoted")
      .map((reference) => reference.id) ?? [];
  if (included.some((quote) => quoteIds.includes(quote.id) && quote.author_id === options.userId)) {
    return { post, users };
  }
  const missing = quoteIds.filter((id) => !included.some((quote) => quote.id === id));
  for (let offset = 0; offset < missing.length; offset += 100) {
    const page = await options.api.getPosts(missing.slice(offset, offset + 100), options.signal);
    if (page.data.some((quote) => quote.author_id === options.userId)) {
      return { post, users };
    }
  }
  return undefined;
}
