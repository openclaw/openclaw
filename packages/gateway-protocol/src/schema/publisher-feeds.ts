import type { Static } from "typebox";
import { Type } from "typebox";
import { closedObject } from "./closed-object.js";

const PublisherIdSchema = Type.String({ minLength: 1, maxLength: 200, pattern: ".*\\S.*" });
const FeedProfileSchema = Type.String({ minLength: 1, maxLength: 100, pattern: ".*\\S.*" });

export const PublisherFeedFollowSchema = closedObject({
  sourceOrigin: Type.String({ format: "uri", maxLength: 2_048 }),
  publisherId: PublisherIdSchema,
  feedProfile: FeedProfileSchema,
  createdAtMs: Type.Integer({ minimum: 0 }),
  updatedAtMs: Type.Integer({ minimum: 0 }),
  acceptedSequence: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
  displayName: Type.Union([Type.String({ maxLength: 512 }), Type.Null()]),
  verifiedAt: Type.Union([Type.String({ format: "date-time" }), Type.Null()]),
});

export const PublisherFeedRefreshStatusSchema = closedObject({
  running: Type.Boolean(),
  stopped: Type.Boolean(),
  lastStartedAt: Type.Union([Type.String({ format: "date-time" }), Type.Null()]),
  lastCompletedAt: Type.Union([Type.String({ format: "date-time" }), Type.Null()]),
  lastFollowCount: Type.Integer({ minimum: 0 }),
  lastRefreshedCount: Type.Integer({ minimum: 0 }),
  lastFailedCount: Type.Integer({ minimum: 0 }),
});

export const PublisherFeedsListParamsSchema = closedObject({});
export const PublisherFeedsListResultSchema = closedObject({
  follows: Type.Array(PublisherFeedFollowSchema),
  refresh: PublisherFeedRefreshStatusSchema,
});

export const PublisherFeedsFollowParamsSchema = closedObject({
  publisherId: PublisherIdSchema,
  feedProfile: FeedProfileSchema,
});
export const PublisherFeedsFollowResultSchema = closedObject({
  follow: PublisherFeedFollowSchema,
});

export const PublisherFeedsUnfollowParamsSchema = PublisherFeedsFollowParamsSchema;
export const PublisherFeedsUnfollowResultSchema = closedObject({ removed: Type.Boolean() });

export const PublisherFeedsRefreshParamsSchema = closedObject({});
export const PublisherFeedsRefreshResultSchema = closedObject({
  status: PublisherFeedRefreshStatusSchema,
});

export const PublisherFeedsStatusParamsSchema = closedObject({});
export const PublisherFeedsStatusResultSchema = closedObject({
  status: PublisherFeedRefreshStatusSchema,
});

export type PublisherFeedFollow = Static<typeof PublisherFeedFollowSchema>;
export type PublisherFeedRefreshStatus = Static<typeof PublisherFeedRefreshStatusSchema>;
export type PublisherFeedsListParams = Static<typeof PublisherFeedsListParamsSchema>;
export type PublisherFeedsListResult = Static<typeof PublisherFeedsListResultSchema>;
export type PublisherFeedsFollowParams = Static<typeof PublisherFeedsFollowParamsSchema>;
export type PublisherFeedsFollowResult = Static<typeof PublisherFeedsFollowResultSchema>;
export type PublisherFeedsUnfollowParams = Static<typeof PublisherFeedsUnfollowParamsSchema>;
export type PublisherFeedsUnfollowResult = Static<typeof PublisherFeedsUnfollowResultSchema>;
export type PublisherFeedsRefreshParams = Static<typeof PublisherFeedsRefreshParamsSchema>;
export type PublisherFeedsRefreshResult = Static<typeof PublisherFeedsRefreshResultSchema>;
export type PublisherFeedsStatusParams = Static<typeof PublisherFeedsStatusParamsSchema>;
export type PublisherFeedsStatusResult = Static<typeof PublisherFeedsStatusResultSchema>;
