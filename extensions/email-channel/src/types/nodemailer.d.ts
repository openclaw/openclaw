declare module "nodemailer" {
  interface TransportOptions {
    host: string;
    port: number;
    secure?: boolean;
    auth: {
      user: string;
      pass: string;
    };
    tls?: {
      rejectUnauthorized?: boolean;
    };
  }

  interface MailOptions {
    from?: string;
    to: string;
    subject?: string;
    text?: string;
    html?: string;
    replyTo?: string;
    references?: string;
    inReplyTo?: string;
  }

  interface SentMessageInfo {
    messageId: string;
    response: string;
  }

  interface Transporter {
    sendMail(mailOptions: MailOptions): Promise<SentMessageInfo>;
    sendMail(
      mailOptions: MailOptions,
      callback: (err: Error | null, info: SentMessageInfo) => void,
    ): void;
    close(): void;
  }

  export function createTransport(options: TransportOptions): Transporter;
}
