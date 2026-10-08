/** Resource operations remain owned by the request-bound MCP view and pending question. */
export type QuestionResourceAction =
  | { action: "preview"; optionIndex: number }
  | {
      action: "upload";
      files: Array<{ name: string; mimeType: string; content: string; relativePath?: string }>;
    };

export type QuestionResourceActionResult =
  | { resources: Array<{ uri: string; name: string }> }
  | {
      preview: {
        viewId?: string;
        contents?: Array<{ text?: string; blob?: string; mimeType?: string }>;
      };
    };
