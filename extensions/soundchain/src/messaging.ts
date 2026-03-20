/**
 * SoundChain Messaging Client
 *
 * GraphQL client for SoundChain DM operations.
 * Used by the channel plugin for outbound messaging
 * and inbound message polling.
 *
 * CRITICAL: `toId` must be a PROFILE ID, not a chat ID.
 * Using chat.id instead of chat.profile.id causes blank page crash
 * (documented Bug #17 in CLAUDE.md).
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ChatMessage {
  id: string;
  message: string;
  fromId?: string;
  toId?: string;
  createdAt: string;
  fromProfile?: { id: string; displayName?: string; handle?: string };
}

export interface Chat {
  id: string;
  message: string;
  fromId?: string;
  unread?: boolean;
  createdAt: string;
  profile?: {
    id: string;
    displayName?: string;
  };
}

// ---------------------------------------------------------------------------
// GraphQL transport
// ---------------------------------------------------------------------------

interface GraphQLResponse {
  data?: Record<string, unknown>;
  errors?: Array<{ message: string }>;
}

async function graphql(
  apiUrl: string,
  token: string,
  query: string,
  variables?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const res = await fetch(apiUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    throw new Error(`SoundChain GraphQL HTTP error ${res.status}: ${res.statusText}`);
  }
  const json = (await res.json()) as GraphQLResponse;

  if (json.errors && json.errors.length > 0) {
    throw new Error(`SoundChain GraphQL: ${json.errors[0].message}`);
  }

  return json.data ?? {};
}

// ---------------------------------------------------------------------------
// Queries & Mutations
// ---------------------------------------------------------------------------

const CHATS_QUERY = `
  query Chats {
    chats(page: { first: 50 }) {
      nodes {
        id
        message
        fromId
        unread
        createdAt
        profile {
          id
          displayName
        }
      }
    }
  }
`;

const SEND_MESSAGE_MUTATION = `
  mutation SendMessage($toId: String!, $message: String!) {
    sendMessage(input: { toId: $toId, message: $message }) {
      message {
        id
        fromId
        toId
        message
        createdAt
      }
    }
  }
`;

const UNREAD_COUNT_QUERY = `
  query UnreadMessageCount {
    unreadMessageCount
  }
`;

const EXPLORE_USERS_QUERY = `
  query ExploreUsers($page: PageInput) {
    exploreUsers(page: $page) {
      nodes {
        id
        userHandle
        displayName
        isFollowed
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

const FOLLOW_PROFILE_MUTATION = `
  mutation FollowProfile($input: FollowProfileInput!) {
    followProfile(input: $input) {
      followedProfile {
        id
        userHandle
        isFollowed
      }
    }
  }
`;

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export interface UserProfile {
  id: string;
  userHandle?: string;
  displayName?: string;
  isFollowed?: boolean;
}

export interface MessagingClient {
  getChats(): Promise<Chat[]>;
  sendMessage(toProfileId: string, message: string): Promise<ChatMessage>;
  getUnreadCount(): Promise<number>;
  getAllUsers(): Promise<UserProfile[]>;
  followUser(profileId: string): Promise<void>;
}

/**
 * Dual-mode client: tries Vercel REST API first (always available),
 * falls back to Lambda GraphQL if REST fails.
 */
export function createMessagingClient(apiUrl: string, token: string): MessagingClient {
  // Derive REST base URL from the configured apiUrl
  // e.g. "https://api.soundchain.io/graphql" → "https://soundchain.io"
  // e.g. "https://staging.soundchain.io/graphql" → "https://staging.soundchain.io"
  let baseUrl: string;
  try {
    const parsed = new URL(apiUrl);
    // Strip "api." prefix if present, preserve port, remove /graphql path
    const host = parsed.hostname.replace(/^api\./, "");
    const port = parsed.port ? `:${parsed.port}` : "";
    baseUrl = `${parsed.protocol}//${host}${port}`;
  } catch {
    baseUrl = "https://soundchain.io";
  }

  const REST_TIMEOUT_MS = 10_000;

  async function restGet(path: string): Promise<Record<string, unknown>> {
    const res = await fetch(`${baseUrl}${path}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(REST_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`REST ${path}: ${res.status}`);
    return (await res.json()) as Record<string, unknown>;
  }

  async function restPost(
    path: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const res = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REST_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`REST ${path}: ${res.status}`);
    return (await res.json()) as Record<string, unknown>;
  }

  return {
    async getChats(): Promise<Chat[]> {
      try {
        const data = await restGet("/api/pulse/chats");
        return (data.chats as Chat[]) ?? [];
      } catch {
        // Fallback to GraphQL
        const data = await graphql(apiUrl, token, CHATS_QUERY);
        const connection = data.chats as { nodes?: Chat[] } | undefined;
        return connection?.nodes ?? [];
      }
    },

    async sendMessage(toProfileId: string, message: string): Promise<ChatMessage> {
      try {
        const data = await restPost("/api/pulse/send", { toId: toProfileId, message });
        const result = data.message as ChatMessage | undefined;
        if (!result) throw new Error("sendMessage returned null");
        return result;
      } catch {
        // Fallback to GraphQL
        const data = await graphql(apiUrl, token, SEND_MESSAGE_MUTATION, {
          toId: toProfileId,
          message,
        });
        const payload = data.sendMessage as { message?: ChatMessage } | undefined;
        const result = payload?.message;
        if (!result) throw new Error("sendMessage returned null");
        return result;
      }
    },

    async getUnreadCount(): Promise<number> {
      try {
        const data = await restGet("/api/pulse/chats");
        const chats = (data.chats as Chat[]) ?? [];
        return chats.filter((c) => c.unread).length;
      } catch {
        const data = await graphql(apiUrl, token, UNREAD_COUNT_QUERY);
        return (data.unreadMessageCount as number | undefined) ?? 0;
      }
    },

    async getAllUsers(): Promise<UserProfile[]> {
      try {
        // Paginate REST users (100 per page, max 1000)
        const allUsers: UserProfile[] = [];
        for (let skip = 0; skip < 1000; skip += 100) {
          const data = await restGet(`/api/pulse/users?limit=100&skip=${skip}`);
          const users = (data.users as UserProfile[]) ?? [];
          allUsers.push(...users);
          if (users.length < 100) break; // Last page
        }
        return allUsers;
      } catch {
        // Fallback to GraphQL pagination
        const allUsers: UserProfile[] = [];
        let cursor: string | null = null;
        let hasNext = true;
        const MAX_PAGES = 20; // Cap at 1,000 users (20 × 50)
        let pageCount = 0;
        while (hasNext && pageCount < MAX_PAGES) {
          pageCount++;
          const page: Record<string, unknown> = { first: 50 };
          if (cursor) page.after = cursor;
          const data = await graphql(apiUrl, token, EXPLORE_USERS_QUERY, { page });
          const connection = data.exploreUsers as
            | { nodes?: UserProfile[]; pageInfo?: { hasNextPage?: boolean; endCursor?: string } }
            | undefined;
          allUsers.push(...(connection?.nodes ?? []));
          hasNext = connection?.pageInfo?.hasNextPage ?? false;
          cursor = connection?.pageInfo?.endCursor ?? null;
        }
        return allUsers;
      }
    },

    async followUser(profileId: string): Promise<void> {
      try {
        await restPost("/api/pulse/follow", { profileId });
      } catch {
        await graphql(apiUrl, token, FOLLOW_PROFILE_MUTATION, {
          input: { followedId: profileId },
        });
      }
    },
  };
}
