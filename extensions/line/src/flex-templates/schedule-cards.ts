import { normalizeLineAction } from "../actions.js";
import {
  cardBox,
  cardText,
  createCardBubble,
  createCardListItem,
  createCardTitle,
} from "./common.js";
import type { Action, FlexBox, FlexBubble, FlexComponent } from "./types.js";

function buildTitleSubtitleHeader(params: { title: string; subtitle?: string }): FlexComponent[] {
  const { title, subtitle } = params;
  const headerContents: FlexComponent[] = [createCardTitle(title)];

  if (subtitle) {
    headerContents.push(
      cardText(subtitle, { size: "sm", color: "#888888", margin: "sm", wrap: true }),
    );
  }

  return headerContents;
}

function buildCardHeaderSections(headerContents: FlexComponent[]): FlexComponent[] {
  return [
    cardBox("vertical", headerContents, { paddingBottom: "lg" }),
    {
      type: "separator",
      color: "#EEEEEE",
    },
  ];
}

export function createReceiptCard(params: {
  title: string;
  items: Array<{ name: string; value: string }>;
  total?: { label: string; value: string };
  footer?: string;
}): FlexBubble {
  const { title, items, total, footer } = params;

  const itemRows: FlexComponent[] = items.slice(0, 12).map((item, index) =>
    cardBox(
      "horizontal",
      [
        cardText(item.name, {
          size: "sm",
          color: "#666666",
          weight: "regular",
          flex: 3,
          wrap: true,
        }),
        ...(item.value
          ? [
              cardText(item.value, {
                size: "sm",
                color: "#333333",
                weight: "regular",
                flex: 2,
                align: "end",
                wrap: true,
              }),
            ]
          : []),
      ],
      { paddingAll: "md", backgroundColor: index % 2 === 0 ? "#FFFFFF" : "#FAFAFA" },
    ),
  );
  const bodyContents: FlexComponent[] = [
    ...buildCardHeaderSections([createCardTitle(title)]),
    cardBox("vertical", itemRows, {
      margin: "md",
      cornerRadius: "md",
      borderWidth: "light",
      borderColor: "#EEEEEE",
    }),
  ];
  if (total) {
    bodyContents.push(
      cardBox(
        "horizontal",
        [
          cardText(total.label, { size: "lg", weight: "bold", color: "#111111", flex: 2 }),
          cardText(total.value, {
            size: "xl",
            weight: "bold",
            color: "#06C755",
            flex: 2,
            align: "end",
          }),
        ],
        { margin: "xl", paddingAll: "lg", backgroundColor: "#F0FDF4", cornerRadius: "lg" },
      ),
    );
  }

  return createCardBubble(bodyContents, footer);
}

export function createEventCard(params: {
  title: string;
  date: string;
  time?: string;
  location?: string;
  description?: string;
  calendar?: string;
  isAllDay?: boolean;
  action?: Action;
}): FlexBubble {
  const { title, date, time, location, description, calendar, isAllDay, action } = params;
  const dateBlock: FlexBox = cardBox(
    "vertical",
    [
      cardText(date.toUpperCase(), { size: "sm", weight: "bold", color: "#06C755", wrap: true }),
      cardText(isAllDay ? "ALL DAY" : (time ?? ""), {
        size: "xxl",
        weight: "bold",
        color: "#111111",
        wrap: true,
        margin: "xs",
      }),
    ],
    { paddingBottom: "lg", borderWidth: "none" },
  );
  if (!time && !isAllDay) {
    dateBlock.contents = [
      cardText(date, { size: "xl", weight: "bold", color: "#111111", wrap: true }),
    ];
  }
  const titleBlock: FlexBox = cardBox(
    "horizontal",
    [
      cardBox("vertical", [], { width: "4px", backgroundColor: "#06C755", cornerRadius: "2px" }),
      cardBox(
        "vertical",
        [
          cardText(title, { size: "lg", weight: "bold", color: "#1a1a1a", wrap: true }),
          ...(calendar
            ? [cardText(calendar, { size: "xs", color: "#888888", margin: "sm", wrap: true })]
            : []),
        ],
        { flex: 1, paddingStart: "lg" },
      ),
    ],
    { paddingTop: "lg", paddingBottom: "lg", borderWidth: "light", borderColor: "#EEEEEE" },
  );

  const bodyContents: FlexComponent[] = [dateBlock, titleBlock];
  const hasDetails = location || description;
  if (hasDetails) {
    const detailItems: FlexComponent[] = [];

    if (location) {
      detailItems.push(
        cardBox(
          "horizontal",
          [
            cardText("📍", { size: "sm", flex: 0 }),
            cardText(location, { size: "sm", color: "#444444", margin: "md", flex: 1, wrap: true }),
          ],
          { alignItems: "flex-start" },
        ),
      );
    }

    if (description) {
      detailItems.push(
        cardText(description, {
          size: "sm",
          color: "#666666",
          wrap: true,
          margin: location ? "lg" : "none",
        }),
      );
    }

    bodyContents.push(
      cardBox("vertical", detailItems, {
        margin: "lg",
        paddingAll: "lg",
        backgroundColor: "#F8F9FA",
        cornerRadius: "lg",
      }),
    );
  }

  const bubble = createCardBubble(bodyContents);
  bubble.body.action = action === undefined ? undefined : normalizeLineAction(action, 40);
  return bubble;
}

export function createAgendaCard(params: {
  title: string;
  subtitle?: string;
  events: Array<{
    title: string;
    time?: string;
    location?: string;
    calendar?: string;
    isNow?: boolean;
  }>;
  footer?: string;
}): FlexBubble {
  const { title, subtitle, events, footer } = params;
  const headerContents = buildTitleSubtitleHeader({ title, subtitle });
  const eventItems: FlexComponent[] = events.slice(0, 6).map((event, index) => {
    const isActive = event.isNow || index === 0;
    const accentColor = isActive ? "#06C755" : "#E5E5E5";
    const timeColumn: FlexBox = cardBox(
      "vertical",
      [
        cardText(event.time ?? "—", {
          size: "sm",
          weight: isActive ? "bold" : "regular",
          color: isActive ? "#06C755" : "#666666",
          align: "end",
          wrap: true,
        }),
      ],
      { width: "65px", justifyContent: "flex-start" },
    );
    const dotColumn: FlexBox = cardBox(
      "vertical",
      [
        cardBox("vertical", [], {
          width: "10px",
          height: "10px",
          backgroundColor: accentColor,
          cornerRadius: "5px",
        }),
      ],
      { width: "24px", alignItems: "center", justifyContent: "flex-start", paddingTop: "xs" },
    );
    const detailColumn = cardBox(
      "vertical",
      createCardListItem(
        event.title,
        [event.location, event.calendar].filter(Boolean).join(" · "),
        "xs",
      ),
      { flex: 1 },
    );

    return cardBox("horizontal", [timeColumn, dotColumn, detailColumn], {
      margin: index > 0 ? "xl" : undefined,
      alignItems: "flex-start",
    });
  });

  const bodyContents: FlexComponent[] = [
    ...buildCardHeaderSections(headerContents),
    cardBox("vertical", eventItems, { paddingTop: "xl" }),
  ];

  return createCardBubble(bodyContents, footer);
}
