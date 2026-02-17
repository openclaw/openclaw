import { AtpAgent } from "@atproto/api";

export interface BlueskySessionOptions {
  identifier: string;
  appPassword: string;
  service: string;
}

export interface BlueskySession {
  agent: AtpAgent;
  did: string;
}

/**
 * Create an authenticated AT Protocol session using app password.
 * The AtpAgent handles session refresh automatically.
 */
export async function createBlueskySession(
  opts: BlueskySessionOptions,
): Promise<BlueskySession> {
  const agent = new AtpAgent({ service: opts.service });

  const response = await agent.login({
    identifier: opts.identifier,
    password: opts.appPassword,
  });

  if (!response.success) {
    throw new Error(`Bluesky login failed for ${opts.identifier}`);
  }

  const did = response.data.did;

  return { agent, did };
}
