import { OpenClawConfig, WizardPrompter } from "openclaw/plugin-sdk";

export enum TypeXMessageEnum {
  text = 0,
  richText = 8,
}

export type TypeXMessage = {
  msg_type: TypeXMessageEnum;
  content: string;
};

export interface TypeXClientOptions {
  token?: string;
  skipConfigCheck?: boolean;
  typexCfg?: Record<string, unknown>;
  prompter?: WizardPrompter;
}

export interface TypeXMessageEntry {
  message_id: string;
  chat_id: string;
  sender_id: string;
  sender_name?: string;
  msg_type: TypeXMessageEnum;
  content: {
    text: string;
  };
  create_time: number;
}
