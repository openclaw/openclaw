export type CallbackContext = {
  chatId: number;
  messageId: number;
  userId: number;
  data: string;
  answerCallback: (text?: string) => Promise<void>;
  editMessage: (text: string, buttons?: any) => Promise<void>;
  sendMessage: (text: string, buttons?: any) => Promise<void>;
};

export type PanelButton = {
  label: string;
  value: string;
  style?: "primary" | "success" | "danger";
};

export type PanelBlock =
  | { type: "text"; text: string }
  | { type: "buttons"; buttons: PanelButton[] };

export type InteractiveReply = {
  blocks: PanelBlock[];
};
