import type { FlexBox, FlexBubble, FlexComponent } from "./types.js";

export function createCardBubble(
  bodyContents: FlexComponent[],
  footer?: string,
): FlexBubble & { body: FlexBox } {
  const bubble: FlexBubble & { body: FlexBox } = {
    type: "bubble",
    size: "mega",
    body: {
      type: "box",
      layout: "vertical",
      contents: bodyContents,
      paddingAll: "xl",
      backgroundColor: "#FFFFFF",
    },
  };
  if (footer) {
    bubble.footer = {
      type: "box",
      layout: "vertical",
      contents: [
        {
          type: "text",
          text: footer,
          size: "xs",
          color: "#AAAAAA",
          wrap: true,
          align: "center",
        },
      ],
      paddingAll: "lg",
      backgroundColor: "#FAFAFA",
    };
  }
  return bubble;
}
