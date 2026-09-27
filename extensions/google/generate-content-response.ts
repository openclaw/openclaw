type GoogleInlineDataPart = {
  mimeType?: string;
  mime_type?: string;
  data?: string;
};

// REST-compatible endpoints may retain the protobuf snake_case field names.
export type GoogleGenerateContentResponse = {
  candidates?: Array<{
    finishReason?: string;
    content?: {
      parts?: Array<{
        text?: string;
        inlineData?: GoogleInlineDataPart;
        inline_data?: GoogleInlineDataPart;
      }>;
    };
  }>;
  promptFeedback?: {
    blockReason?: string;
  };
};
