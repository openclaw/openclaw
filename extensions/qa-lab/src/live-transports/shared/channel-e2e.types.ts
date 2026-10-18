export type QaChannelE2eMessage = {
  id: string;
  channelId: string;
  threadId?: string;
  text: string;
  actor: "driver" | "sut" | "other";
  attachments?: Array<{ id: string; name?: string; contentType?: string; url?: string }>;
};

type QaChannelE2eCapabilities = {
  automated: string[];
  observationOnly: string[];
  manualClient: string[];
  unavailable: Array<{ capability: string; reason: string }>;
};

export type QaChannelE2eDoctorResult = {
  ok: boolean;
  checks: Array<{ name: string; ok: boolean; detail?: string }>;
  capabilities: QaChannelE2eCapabilities;
};

/** Native fixture operations; Gateway/model assertions remain separate evidence. */
export type QaChannelE2eDriver = {
  doctor(): Promise<QaChannelE2eDoctorResult>;
  readonly signal?: AbortSignal;
  assertActive(): void;
  send(input: {
    text: string;
    mention?: boolean;
    threadId?: string;
    replyToMessageId?: string;
  }): Promise<QaChannelE2eMessage>;
  upload(input: {
    path: string;
    text?: string;
    mention?: boolean;
    threadId?: string;
    fileName?: string;
  }): Promise<QaChannelE2eMessage>;
  read(input?: {
    messageId?: string;
    threadId?: string;
    limit?: number;
    before?: string;
    after?: string;
  }): Promise<QaChannelE2eMessage[]>;
  edit(input: { messageId: string; text: string; threadId?: string }): Promise<QaChannelE2eMessage>;
  delete(input: { messageId: string; threadId?: string }): Promise<void>;
  react(input: {
    messageId: string;
    emoji: string;
    remove?: boolean;
    threadId?: string;
  }): Promise<void>;
  thread(input: { name: string; messageId?: string; text?: string }): Promise<{ threadId: string }>;
  waitForReply(input: {
    textIncludes?: string;
    afterMessageId?: string;
    threadId?: string;
    timeoutMs?: number;
  }): Promise<QaChannelE2eMessage>;
};
