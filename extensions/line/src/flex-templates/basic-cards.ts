import { normalizeLineAction } from "../actions.js";
import { createCardBubble } from "./common.js";
import type {
  Action,
  CardAction,
  FlexBox,
  FlexBubble,
  FlexButton,
  FlexComponent,
  FlexImage,
  FlexText,
  ListItem,
} from "./types.js";

export function createInfoCard(title: string, body: string, footer?: string): FlexBubble {
  return createCardBubble(
    [
      {
        type: "box",
        layout: "horizontal",
        contents: [
          {
            type: "box",
            layout: "vertical",
            contents: [],
            width: "4px",
            backgroundColor: "#06C755",
            cornerRadius: "2px",
          } as FlexBox,
          {
            type: "text",
            text: title,
            weight: "bold",
            size: "xl",
            color: "#111111",
            wrap: true,
            flex: 1,
            margin: "lg",
          } as FlexText,
        ],
      } as FlexBox,
      // Body text in subtle container, only when there is a body to show:
      // LINE rejects the whole push when a Flex text is blank.
      ...(body
        ? [
            {
              type: "box",
              layout: "vertical",
              contents: [
                {
                  type: "text",
                  text: body,
                  size: "md",
                  color: "#444444",
                  wrap: true,
                  lineSpacing: "6px",
                } as FlexText,
              ],
              margin: "xl",
              paddingAll: "lg",
              backgroundColor: "#F8F9FA",
              cornerRadius: "lg",
            } as FlexBox,
          ]
        : []),
    ],
    footer,
  );
}

export function createListCard(title: string, items: ListItem[]): FlexBubble {
  const itemContents: FlexComponent[] = items.slice(0, 8).map((item, index) => {
    const itemContentsLocal: FlexComponent[] = [
      {
        type: "text",
        text: item.title,
        size: "md",
        weight: "bold",
        color: "#1a1a1a",
        wrap: true,
      } as FlexText,
    ];

    if (item.subtitle) {
      itemContentsLocal.push({
        type: "text",
        text: item.subtitle,
        size: "sm",
        color: "#888888",
        wrap: true,
        margin: "xs",
      } as FlexText);
    }

    const itemBox: FlexBox = {
      type: "box",
      layout: "horizontal",
      contents: [
        {
          type: "box",
          layout: "vertical",
          contents: [
            {
              type: "box",
              layout: "vertical",
              contents: [],
              width: "8px",
              height: "8px",
              backgroundColor: index === 0 ? "#06C755" : "#DDDDDD",
              cornerRadius: "4px",
            } as FlexBox,
          ],
          width: "20px",
          alignItems: "center",
          paddingTop: "sm",
        } as FlexBox,
        {
          type: "box",
          layout: "vertical",
          contents: itemContentsLocal,
          flex: 1,
        } as FlexBox,
      ],
      margin: index > 0 ? "lg" : undefined,
    };

    if (item.action) {
      itemBox.action = normalizeLineAction(item.action, 40);
    }

    return itemBox;
  });

  return createCardBubble([
    {
      type: "text",
      text: title,
      weight: "bold",
      size: "xl",
      color: "#111111",
      wrap: true,
    } as FlexText,
    {
      type: "separator",
      margin: "lg",
      color: "#EEEEEE",
    },
    {
      type: "box",
      layout: "vertical",
      contents: itemContents,
      margin: "lg",
    } as FlexBox,
  ]);
}

function createTitleBody(title: string, body?: string): FlexBox {
  const box: FlexBox = {
    type: "box",
    layout: "vertical",
    contents: [
      {
        type: "text",
        text: title,
        weight: "bold",
        size: "xl",
        wrap: true,
      },
    ],
    paddingAll: "lg",
  };

  if (body) {
    box.contents.push({
      type: "text",
      text: body,
      size: "md",
      wrap: true,
      margin: "md",
      color: "#666666",
    });
  }
  return box;
}

export function createImageCard(
  imageUrl: string,
  title: string,
  body?: string,
  options?: {
    aspectRatio?: "1:1" | "1.51:1" | "1.91:1" | "4:3" | "16:9" | "20:13" | "2:1" | "3:1";
    aspectMode?: "cover" | "fit";
    action?: Action;
  },
): FlexBubble {
  return {
    type: "bubble",
    hero: {
      type: "image",
      url: imageUrl,
      size: "full",
      aspectRatio: options?.aspectRatio ?? "20:13",
      aspectMode: options?.aspectMode ?? "cover",
      action: options?.action === undefined ? undefined : normalizeLineAction(options.action, 40),
    },
    body: createTitleBody(title, body),
  };
}

export function createActionCard(
  title: string,
  body: string,
  actions: CardAction[],
  options?: {
    imageUrl?: string;
    aspectRatio?: "1:1" | "1.51:1" | "1.91:1" | "4:3" | "16:9" | "20:13" | "2:1" | "3:1";
  },
): FlexBubble {
  const bubble: FlexBubble = {
    type: "bubble",
    body: createTitleBody(title, body),
    footer: {
      type: "box",
      layout: "vertical",
      contents: actions.slice(0, 4).map(
        (action, index) =>
          ({
            type: "button",
            action: normalizeLineAction(action.action, 40),
            style: index === 0 ? "primary" : "secondary",
            margin: index > 0 ? "sm" : undefined,
          }) as FlexButton,
      ),
      paddingAll: "md",
    },
  };

  if (options?.imageUrl) {
    bubble.hero = {
      type: "image",
      url: options.imageUrl,
      size: "full",
      aspectRatio: options.aspectRatio ?? "20:13",
      aspectMode: "cover",
    } as FlexImage;
  }

  return bubble;
}
