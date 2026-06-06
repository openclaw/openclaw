// Feishu plugin module implements event types behavior.
export type FeishuMessageEvent = {
  sender: {
    sender_id: {
      open_id?: string;
      user_id?: string;
      union_id?: string;
    };
    /**
     * sender_type from `im.message.receive_v1` webhook events.
     * NOTE: Distinct from the `im.v1.message.get` API response which returns
     * `"app"` instead of `"bot"`. Do not conflate the two — downstream logic
     * (e.g. the self-filter and bot sender-name resolution) depends on this literal.
     */
    sender_type?: "user" | "bot";
    tenant_key?: string;
  };
  message: {
    message_id: string;
    reply_target_message_id?: string;
    suppress_reply_target?: boolean;
    root_id?: string;
    parent_id?: string;
    thread_id?: string;
    chat_id: string;
    chat_type: "p2p" | "group" | "topic_group" | "private";
    message_type: string;
    content: string;
    create_time?: string;
    mentions?: Array<{
      key: string;
      id: {
        open_id?: string;
        user_id?: string;
        union_id?: string;
      };
      name: string;
      tenant_key?: string;
      /**
       * Only emitted by webhook events that include bot @-mentions, gated by
       * the Feishu scope `im:message.group_at_msg.include_bot:readonly`.
       */
      mentioned_type?: "user" | "bot";
    }>;
  };
};

export type FeishuBotAddedEvent = {
  chat_id: string;
  operator_id: {
    open_id?: string;
    user_id?: string;
    union_id?: string;
  };
  external: boolean;
  operator_tenant_key?: string;
};
