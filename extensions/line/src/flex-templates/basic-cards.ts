import { normalizeLineAction } from "../actions.js";
import {
  cardBox,
  cardText,
  createCardBubble,
  createCardListItem,
  createCardTitle,
} from "./common.js";
import type { Action, FlexBox, FlexBubble, FlexButton, FlexImage, ListItem } from "./types.js";

export function createInfoCard(title: string, body: string, footer?: string): FlexBubble {
  return createCardBubble(
    [
      cardBox("horizontal", [
        cardBox("vertical", [], { width: "4px", backgroundColor: "#06C755", cornerRadius: "2px" }),
        {
          ...createCardTitle(title),
          flex: 1,
          margin: "lg",
        },
      ]),
      // Body text in subtle container, only when there is a body to show:
      // LINE rejects the whole push when a Flex text is blank.
      ...(body
        ? [
            cardBox(
              "vertical",
              [cardText(body, { size: "md", color: "#444444", wrap: true, lineSpacing: "6px" })],
              { margin: "xl", paddingAll: "lg", backgroundColor: "#F8F9FA", cornerRadius: "lg" },
            ),
          ]
        : []),
    ],
    footer,
  );
}

export function createListCard(title: string, items: ListItem[]): FlexBubble {
  const itemContents = items.slice(0, 8).map<FlexBox>((item, index) => {
    return cardBox(
      "horizontal",
      [
        cardBox(
          "vertical",
          [
            cardBox("vertical", [], {
              width: "8px",
              height: "8px",
              backgroundColor: index === 0 ? "#06C755" : "#DDDDDD",
              cornerRadius: "4px",
            }),
          ],
          { width: "20px", alignItems: "center", paddingTop: "sm" },
        ),
        cardBox("vertical", createCardListItem(item.title, item.subtitle, "sm"), { flex: 1 }),
      ],
      { margin: index > 0 ? "lg" : undefined },
    );
  });

  return createCardBubble([
    createCardTitle(title),
    {
      type: "separator",
      margin: "lg",
      color: "#EEEEEE",
    },
    cardBox("vertical", itemContents, { margin: "lg" }),
  ]);
}

function createTitleBody(title: string, body?: string): FlexBox {
  const box: FlexBox = cardBox(
    "vertical",
    [cardText(title, { weight: "bold", size: "xl", wrap: true })],
    { paddingAll: "lg" },
  );

  if (body) {
    box.contents.push(cardText(body, { size: "md", wrap: true, margin: "md", color: "#666666" }));
  }
  return box;
}

export function createImageCard(imageUrl: string, title: string, body?: string): FlexBubble {
  return {
    type: "bubble",
    hero: {
      type: "image",
      url: imageUrl,
      size: "full",
      aspectRatio: "20:13",
      aspectMode: "cover",
      action: undefined,
    },
    body: createTitleBody(title, body),
  };
}

export function createActionCard(
  title: string,
  body: string,
  actions: Action[],
  options?: {
    imageUrl?: string;
  },
): FlexBubble {
  const bubble: FlexBubble = {
    type: "bubble",
    body: createTitleBody(title, body),
    footer: cardBox(
      "vertical",
      actions.slice(0, 4).map(
        (action, index) =>
          ({
            type: "button",
            action: normalizeLineAction(action, 40),
            style: index === 0 ? "primary" : "secondary",
            margin: index > 0 ? "sm" : undefined,
          }) as FlexButton,
      ),
      { paddingAll: "md" },
    ),
  };

  if (options?.imageUrl) {
    bubble.hero = {
      type: "image",
      url: options.imageUrl,
      size: "full",
      aspectRatio: "20:13",
      aspectMode: "cover",
    } as FlexImage;
  }

  return bubble;
}
