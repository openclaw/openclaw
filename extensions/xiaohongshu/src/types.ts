export interface XhsApiResponse<T = unknown> {
  code: number;
  success: boolean;
  msg: string;
  data?: T;
}

export interface XhsUserInfo {
  nickname: string;
  userid: string;
  desc: string;
  imageb: string;
  red_id: string;
  gender: number;
  fans: string;
  follows: string;
  interaction: string;
}

export interface XhsNoteCard {
  note_id: string;
  display_title: string;
  title: string;
  desc: string;
  type: string;
  user: { nickname: string; user_id: string; avatar: string };
  time: number;
  interact_info: {
    liked_count: string;
    comment_count: string;
    collected_count: string;
    share_count: string;
  };
  image_list?: Array<{ url_pre: string; url_default: string }>;
  cover?: { url_default: string };
}

export interface XhsSearchItem {
  id: string;
  xsec_token: string;
  model_type: string;
  note_card: XhsNoteCard;
}

export interface XhsFeedItem {
  id: string;
  xsec_token: string;
  note_card: XhsNoteCard;
}

export interface XhsComment {
  id: string;
  content: string;
  create_time: number;
  like_count: string;
  user_info: { nickname: string; user_id: string; image: string };
  sub_comments?: XhsComment[];
}

export interface XhsPluginConfig {
  cookie?: string;
}
