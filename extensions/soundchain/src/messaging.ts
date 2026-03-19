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
  });

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
    chats(page: { first: 25 }) {
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

export function createMessagingClient(apiUrl: string, token: string): MessagingClient {
  return {
    async getChats(): Promise<Chat[]> {
      const data = await graphql(apiUrl, token, CHATS_QUERY);
      const connection = data.chats as { nodes?: Chat[] } | undefined;
      return connection?.nodes ?? [];
    },

    async sendMessage(toProfileId: string, message: string): Promise<ChatMessage> {
      const data = await graphql(apiUrl, token, SEND_MESSAGE_MUTATION, {
        toId: toProfileId,
        message,
      });
      const payload = data.sendMessage as { message?: ChatMessage } | undefined;
      const result = payload?.message;
      if (!result) throw new Error("sendMessage returned null");
      return result;
    },

    async getUnreadCount(): Promise<number> {
      const data = await graphql(apiUrl, token, UNREAD_COUNT_QUERY);
      return (data.unreadMessageCount as number | undefined) ?? 0;
    },

    async getAllUsers(): Promise<UserProfile[]> {
      const allUsers: UserProfile[] = [];
      let cursor: string | null = null;
      let hasNext = true;

      while (hasNext) {
        const page: Record<string, unknown> = { first: 50 };
        if (cursor) page.after = cursor;

        const data = await graphql(apiUrl, token, EXPLORE_USERS_QUERY, { page });
        const connection = data.exploreUsers as
          | {
              nodes?: UserProfile[];
              pageInfo?: { hasNextPage?: boolean; endCursor?: string };
            }
          | undefined;

        const nodes = connection?.nodes ?? [];
        allUsers.push(...nodes);

        hasNext = connection?.pageInfo?.hasNextPage ?? false;
        cursor = connection?.pageInfo?.endCursor ?? null;
      }

      return allUsers;
    },

    async followUser(profileId: string): Promise<void> {
      await graphql(apiUrl, token, FOLLOW_PROFILE_MUTATION, {
        input: { followedId: profileId },
      });
    },
  };
}
