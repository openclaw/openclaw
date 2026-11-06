import type { XApiClient, XPost } from "./api.js";

/** Never infer audience from a permalink, mention feed, or user-context API success. */
export async function verifyPublicXThread(
  api: Pick<XApiClient, "getPublicPosts">,
  posts: readonly XPost[],
  signal: AbortSignal,
  rootId: string,
): Promise<boolean> {
  if (!posts.some((post) => post.id === rootId)) {
    return false;
  }
  try {
    const page = await api.getPublicPosts(
      posts.map((post) => post.id),
      signal,
    );
    signal.throwIfAborted();
    const publicPosts = new Map(page.data.map((post) => [post.id, post]));
    const authors = new Map(page.includes.users.map((user) => [user.id, user]));
    return posts.every((post) => {
      const publicPost = publicPosts.get(post.id);
      return (
        publicPost !== undefined &&
        publicPost.text === post.text &&
        publicPost.author_id === post.author_id &&
        publicPost.conversation_id === post.conversation_id &&
        !publicPost.withheld &&
        !post.withheld &&
        authors.get(post.author_id)?.protected === false
      );
    });
  } catch {
    signal.throwIfAborted();
    // Missing entitlement, field, deleted/protected post, or lookup error denies only publication.
    return false;
  }
}
