import type { FlexBox, FlexBubble, FlexComponent, FlexText } from "./types.js";

export function cardText(text: string, style: Omit<FlexText, "type" | "text">): FlexText {
  return { type: "text", text, ...style };
}

export function cardBox(
  layout: FlexBox["layout"],
  contents: FlexComponent[],
  style: Omit<FlexBox, "type" | "layout" | "contents"> = {},
): FlexBox {
  return { type: "box", layout, contents, ...style };
}

export function createCardTitle(text: string): FlexText {
  return { type: "text", text, weight: "bold", size: "xl", color: "#111111", wrap: true };
}

export function createCardListItem(
  title: string,
  subtitle: string | undefined,
  subtitleSize: "sm" | "xs",
): FlexComponent[] {
  const contents: FlexComponent[] = [
    cardText(title, { size: "md", weight: "bold", color: "#1a1a1a", wrap: true }),
  ];
  if (subtitle) {
    contents.push(
      cardText(subtitle, { size: subtitleSize, color: "#888888", wrap: true, margin: "xs" }),
    );
  }
  return contents;
}

export function createCardBubble(
  bodyContents: FlexComponent[],
  footer?: string,
): FlexBubble & { body: FlexBox } {
  const bubble: FlexBubble & { body: FlexBox } = {
    type: "bubble",
    size: "mega",
    body: cardBox("vertical", bodyContents, {
      paddingAll: "xl",
      backgroundColor: "#FFFFFF",
    }),
  };
  if (footer) {
    bubble.footer = cardBox(
      "vertical",
      [
        cardText(footer, {
          size: "xs",
          color: "#AAAAAA",
          wrap: true,
          align: "center",
        }),
      ],
      {
        paddingAll: "lg",
        backgroundColor: "#FAFAFA",
      },
    );
  }
  return bubble;
}
