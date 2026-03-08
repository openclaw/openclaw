export interface VRChatCredentials {
  username: string;
  password: string;
  otpCode?: string;
}

export interface VRChatSession {
  authToken: string;
  twoFactorAuth?: string;
  userId: string;
  displayName: string;
}

export interface VRChatUser {
  id: string;
  displayName: string;
  bio: string;
  currentAvatarImageUrl: string;
  currentAvatarThumbnailImageUrl: string;
  status: string;
  statusDescription: string;
  state: string;
  last_login: string;
}

export interface VRChatWorld {
  id: string;
  name: string;
  authorName: string;
  description: string;
  imageUrl: string;
  thumbnailImageUrl: string;
  capacity: number;
  occupants: number;
  favorites: number;
  featured: boolean;
}

export interface VRChatInstance {
  id: string;
  worldId: string;
  type: string;
  region: string;
  capacity: number;
  occupants: number;
}

export interface VRChatError {
  message: string;
  statusCode: number;
}

export type Result<T, E = VRChatError> = { ok: true; value: T } | { ok: false; error: E };

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}
