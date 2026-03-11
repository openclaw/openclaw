import { Type, type Static } from "@sinclair/typebox";

export const CheckCookieSchema = Type.Object({});
export type CheckCookieParams = Static<typeof CheckCookieSchema>;

export const SearchNotesSchema = Type.Object({
  keywords: Type.String({ description: "Search keywords" }),
  limit: Type.Optional(
    Type.Number({ description: "Max results to return (default 20)", minimum: 1, maximum: 40 }),
  ),
});
export type SearchNotesParams = Static<typeof SearchNotesSchema>;

export const GetNoteSchema = Type.Object({
  url: Type.String({
    description:
      "Xiaohongshu note URL (must include xsec_token), e.g. https://www.xiaohongshu.com/explore/<note_id>?xsec_token=...",
  }),
});
export type GetNoteParams = Static<typeof GetNoteSchema>;

export const GetCommentsSchema = Type.Object({
  url: Type.String({
    description:
      "Xiaohongshu note URL (must include xsec_token), e.g. https://www.xiaohongshu.com/explore/<note_id>?xsec_token=...",
  }),
});
export type GetCommentsParams = Static<typeof GetCommentsSchema>;

export const PostCommentSchema = Type.Object({
  note_id: Type.String({ description: "Note ID to comment on" }),
  comment: Type.String({ description: "Comment content" }),
});
export type PostCommentParams = Static<typeof PostCommentSchema>;

export const HomeFeedSchema = Type.Object({});
export type HomeFeedParams = Static<typeof HomeFeedSchema>;
