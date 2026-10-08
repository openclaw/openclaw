import { postbackAction, truncateLineActionLabel } from "../actions.js";
import { createCardBubble, createCardTitle } from "./common.js";
import type {
  FlexBox,
  FlexBubble,
  FlexButton,
  FlexComponent,
  FlexImage,
  FlexText,
} from "./types.js";

function horizontalRow(
  contents: FlexComponent[],
  options: Pick<FlexBox, "margin" | "alignItems"> = {},
): FlexBox {
  return { type: "box", layout: "horizontal", contents, ...options };
}

export function createMediaPlayerCard(params: {
  title: string;
  subtitle?: string;
  source?: string;
  imageUrl?: string;
  isPlaying?: boolean;
  controls: Record<"previous" | "play" | "pause" | "next", { data: string }>;
}): FlexBubble {
  const { title, subtitle, source, imageUrl, isPlaying, controls } = params;
  const trackInfo: FlexComponent[] = [createCardTitle(title)];

  if (subtitle) {
    trackInfo.push({
      type: "text",
      text: subtitle,
      size: "md",
      color: "#666666",
      wrap: true,
      margin: "sm",
    } as FlexText);
  }
  const statusItems: FlexComponent[] = [];

  if (isPlaying !== undefined) {
    statusItems.push(
      horizontalRow(
        [
          {
            type: "box",
            layout: "vertical",
            contents: [],
            width: "8px",
            height: "8px",
            backgroundColor: isPlaying ? "#06C755" : "#CCCCCC",
            cornerRadius: "4px",
          } as FlexBox,
          {
            type: "text",
            text: isPlaying ? "Now Playing" : "Paused",
            size: "xs",
            color: isPlaying ? "#06C755" : "#888888",
            weight: "bold",
            margin: "sm",
          } as FlexText,
        ],
        { alignItems: "center" },
      ),
    );
  }

  if (source) {
    statusItems.push({
      type: "text",
      text: source,
      size: "xs",
      color: "#AAAAAA",
      margin: statusItems.length > 0 ? "lg" : undefined,
    } as FlexText);
  }

  const bodyContents: FlexComponent[] = [
    {
      type: "box",
      layout: "vertical",
      contents: trackInfo,
    } as FlexBox,
  ];

  if (statusItems.length > 0) {
    bodyContents.push(horizontalRow(statusItems, { margin: "lg", alignItems: "center" }));
  }

  const bubble = createCardBubble(bodyContents);
  if (imageUrl) {
    bubble.hero = {
      type: "image",
      url: imageUrl,
      size: "full",
      aspectRatio: "1:1",
      aspectMode: "cover",
    } as FlexImage;
  }
  const controlButtons: FlexComponent[] = [];
  for (const [key, label, style] of [
    ["previous", "⏮", "secondary"],
    ["play", "▶", isPlaying ? "secondary" : "primary"],
    ["pause", "⏸", isPlaying ? "primary" : "secondary"],
    ["next", "⏭", "secondary"],
  ] as const) {
    const button: FlexButton = {
      type: "button",
      action: postbackAction(label, controls[key].data),
      style,
      flex: 1,
      height: "sm",
    };
    if (key !== "previous") {
      button.margin = "md";
    }
    controlButtons.push(button);
  }
  bubble.footer = {
    type: "box",
    layout: "vertical",
    contents: [horizontalRow(controlButtons)],
    paddingAll: "lg",
    backgroundColor: "#FAFAFA",
  };

  return bubble;
}

export function createAppleTvRemoteCard(params: {
  deviceName: string;
  status?: string;
  actionData: {
    up: string;
    down: string;
    left: string;
    right: string;
    select: string;
    menu: string;
    home: string;
    play: string;
    pause: string;
    volumeUp: string;
    volumeDown: string;
    mute: string;
  };
}): FlexBubble {
  const { deviceName, status, actionData } = params;

  const headerContents: FlexComponent[] = [createCardTitle(deviceName)];

  if (status) {
    headerContents.push({
      type: "text",
      text: status,
      size: "sm",
      color: "#666666",
      wrap: true,
      margin: "sm",
    } as FlexText);
  }

  const makeButton = (
    label: string,
    data: string,
    style: "primary" | "secondary" = "secondary",
  ): FlexButton => ({
    type: "button",
    action: postbackAction(label, data),
    style,
    height: "sm",
    flex: 1,
  });

  const controlRows: FlexComponent[] = [
    horizontalRow([{ type: "filler" }, makeButton("↑", actionData.up), { type: "filler" }]),
    horizontalRow(
      [
        makeButton("←", actionData.left),
        makeButton("OK", actionData.select, "primary"),
        makeButton("→", actionData.right),
      ],
      { margin: "md" },
    ),
    horizontalRow([{ type: "filler" }, makeButton("↓", actionData.down), { type: "filler" }], {
      margin: "md",
    }),
    horizontalRow([makeButton("Menu", actionData.menu), makeButton("Home", actionData.home)], {
      margin: "lg",
    }),
    horizontalRow([makeButton("Play", actionData.play), makeButton("Pause", actionData.pause)], {
      margin: "md",
    }),
    horizontalRow(
      [
        makeButton("Vol +", actionData.volumeUp),
        makeButton("Mute", actionData.mute),
        makeButton("Vol -", actionData.volumeDown),
      ],
      { margin: "md" },
    ),
  ];

  return createCardBubble([
    {
      type: "box",
      layout: "vertical",
      contents: headerContents,
    },
    {
      type: "separator",
      margin: "lg",
      color: "#EEEEEE",
    },
    ...controlRows,
  ]);
}

export function createDeviceControlCard(params: {
  deviceName: string;
  deviceType?: string;
  status?: string;
  controls: Array<{
    label: string;
    data: string;
  }>;
}): FlexBubble {
  const { deviceName, deviceType, status, controls } = params;
  const headerContents: FlexComponent[] = [
    horizontalRow(
      [
        {
          type: "box",
          layout: "vertical",
          contents: [],
          width: "10px",
          height: "10px",
          backgroundColor: "#06C755",
          cornerRadius: "5px",
        } as FlexBox,
        {
          ...createCardTitle(deviceName),
          flex: 1,
          margin: "md",
        },
      ],
      { alignItems: "center" },
    ),
  ];

  if (deviceType) {
    headerContents.push({
      type: "text",
      text: deviceType,
      size: "sm",
      color: "#888888",
      margin: "sm",
    } as FlexText);
  }

  if (status) {
    headerContents.push({
      type: "box",
      layout: "vertical",
      contents: [
        {
          type: "text",
          text: status,
          size: "sm",
          color: "#444444",
          wrap: true,
        } as FlexText,
      ],
      margin: "lg",
      paddingAll: "md",
      backgroundColor: "#F8F9FA",
      cornerRadius: "md",
    } as FlexBox);
  }

  const bubble = createCardBubble(headerContents);

  if (controls.length > 0) {
    const rows: FlexComponent[] = [];
    const limitedControls = controls.slice(0, 6);

    for (let i = 0; i < limitedControls.length; i += 2) {
      const rowButtons: FlexComponent[] = [];

      for (const [offset, ctrl] of limitedControls.slice(i, i + 2).entries()) {
        rowButtons.push({
          type: "button",
          action: postbackAction(truncateLineActionLabel(ctrl.label, 18), ctrl.data),
          style: "secondary",
          flex: 1,
          height: "sm",
          margin: offset > 0 ? "md" : undefined,
        } as FlexButton);
      }
      if (rowButtons.length === 1) {
        rowButtons.push({
          type: "filler",
        });
      }

      rows.push(horizontalRow(rowButtons, { margin: i > 0 ? "md" : undefined }));
    }

    bubble.footer = {
      type: "box",
      layout: "vertical",
      contents: rows,
      paddingAll: "lg",
      backgroundColor: "#FAFAFA",
    };
  }

  return bubble;
}
