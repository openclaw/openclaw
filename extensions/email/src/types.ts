export type EmailAccountConfig = {
  enabled?: boolean;
  name?: string;

  // IMAP
  imapHost?: string;
  imapPort?: number;
  imapUsername?: string;
  imapPassword?: string;
  imapPasswordFile?: string;
  imapMailbox?: string;
  imapUseSsl?: boolean;

  // SMTP
  smtpHost?: string;
  smtpPort?: number;
  smtpUsername?: string;
  smtpPassword?: string;
  smtpPasswordFile?: string;
  smtpUseTls?: boolean;
  smtpUseSsl?: boolean;
  fromAddress?: string;

  // Behaviour
  autoReplyEnabled?: boolean;
  consentGranted?: boolean;
  pollIntervalSeconds?: number;
  markSeen?: boolean;
  maxBodyChars?: number;
  subjectPrefix?: string;

  // Access control
  dmPolicy?: string;
  allowFrom?: string[];
};

export type CoreConfig = {
  channels?: {
    email?: EmailAccountConfig & {
      accounts?: Record<string, EmailAccountConfig | undefined>;
      defaultAccount?: string;
    };
  };
};

export type EmailInboundMessage = {
  messageId: string;
  uid: string;
  from: string;
  subject: string;
  date: string;
  inReplyTo?: string;
  references?: string;
  text: string;
  attachments: EmailAttachment[];
  timestamp: number;
};

export type EmailAttachment = {
  filename: string;
  contentType: string;
  sizeBytes: number;
};
