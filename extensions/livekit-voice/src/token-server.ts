import { AccessToken, type VideoGrant } from "livekit-server-sdk";

export async function generateToken(
  apiKey: string,
  apiSecret: string,
  room: string,
  identity: string,
  name?: string,
): Promise<string> {
  const token = new AccessToken(apiKey, apiSecret, {
    identity,
    name: name || identity,
    ttl: "15m",
  });
  const grant: VideoGrant = {
    roomJoin: true,
    room,
    canPublish: true,
    canPublishData: true,
    canSubscribe: true,
  };
  token.addGrant(grant);
  return token.toJwt();
}

export function generateRoomName(prefix = "ada-voice"): string {
  return `${prefix}-${Math.floor(Math.random() * 100000)}`;
}
