import { postbackAction, truncateLineActionLabel } from "../actions.js";
import { cardBox, cardText, createCardBubble, createCardTitle } from "./common.js";
import type { FlexBox, FlexBubble, FlexButton, FlexComponent, FlexImage } from "./types.js";

function createControlButton(
  label: string,
  data: string,
  style: "primary" | "secondary" = "secondary",
): FlexButton {
  return { type: "button", action: postbackAction(label, data), style, height: "sm", flex: 1 };
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
    trackInfo.push(cardText(subtitle, { size: "md", color: "#666666", wrap: true, margin: "sm" }));
  }
  const statusItems: FlexComponent[] = [];

  if (isPlaying !== undefined) {
    statusItems.push(
      cardBox(
        "horizontal",
        [
          cardBox("vertical", [], {
            width: "8px",
            height: "8px",
            backgroundColor: isPlaying ? "#06C755" : "#CCCCCC",
            cornerRadius: "4px",
          }),
          cardText(isPlaying ? "Now Playing" : "Paused", {
            size: "xs",
            color: isPlaying ? "#06C755" : "#888888",
            weight: "bold",
            margin: "sm",
          }),
        ],
        { alignItems: "center" },
      ),
    );
  }

  if (source) {
    statusItems.push(
      cardText(source, {
        size: "xs",
        color: "#AAAAAA",
        margin: statusItems.length > 0 ? "lg" : undefined,
      }),
    );
  }

  const bodyContents: FlexComponent[] = [cardBox("vertical", trackInfo)];

  if (statusItems.length > 0) {
    bodyContents.push(cardBox("horizontal", statusItems, { margin: "lg", alignItems: "center" }));
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
    const button = createControlButton(label, controls[key].data, style);
    if (key !== "previous") {
      button.margin = "md";
    }
    controlButtons.push(button);
  }
  bubble.footer = cardBox("vertical", [cardBox("horizontal", controlButtons)], {
    paddingAll: "lg",
    backgroundColor: "#FAFAFA",
  });

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
    headerContents.push(
      cardText(status, { size: "sm", color: "#666666", wrap: true, margin: "sm" }),
    );
  }

  const labels: Record<keyof typeof actionData, string> = {
    up: "↑",
    down: "↓",
    left: "←",
    right: "→",
    select: "OK",
    menu: "Menu",
    home: "Home",
    play: "Play",
    pause: "Pause",
    volumeUp: "Vol +",
    volumeDown: "Vol -",
    mute: "Mute",
  };
  const rows: [FlexBox["margin"], Array<keyof typeof actionData | null>][] = [
    [undefined, [null, "up", null]],
    ["md", ["left", "select", "right"]],
    ["md", [null, "down", null]],
    ["lg", ["menu", "home"]],
    ["md", ["play", "pause"]],
    ["md", ["volumeUp", "mute", "volumeDown"]],
  ];
  const controlRows = rows.map(([margin, buttons]) =>
    cardBox(
      "horizontal",
      buttons.map((key) =>
        key
          ? createControlButton(
              labels[key],
              actionData[key],
              key === "select" ? "primary" : "secondary",
            )
          : { type: "filler" },
      ),
      margin ? { margin } : {},
    ),
  );

  return createCardBubble([
    cardBox("vertical", headerContents),
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
    cardBox(
      "horizontal",
      [
        cardBox("vertical", [], {
          width: "10px",
          height: "10px",
          backgroundColor: "#06C755",
          cornerRadius: "5px",
        }),
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
    headerContents.push(cardText(deviceType, { size: "sm", color: "#888888", margin: "sm" }));
  }

  if (status) {
    headerContents.push(
      cardBox("vertical", [cardText(status, { size: "sm", color: "#444444", wrap: true })], {
        margin: "lg",
        paddingAll: "md",
        backgroundColor: "#F8F9FA",
        cornerRadius: "md",
      }),
    );
  }

  const bubble = createCardBubble(headerContents);

  if (controls.length > 0) {
    const rows: FlexComponent[] = [];
    const limitedControls = controls.slice(0, 6);

    for (let i = 0; i < limitedControls.length; i += 2) {
      const rowButtons: FlexComponent[] = [];

      for (const [offset, ctrl] of limitedControls.slice(i, i + 2).entries()) {
        rowButtons.push({
          ...createControlButton(truncateLineActionLabel(ctrl.label, 18), ctrl.data),
          margin: offset > 0 ? "md" : undefined,
        });
      }
      if (rowButtons.length === 1) {
        rowButtons.push({
          type: "filler",
        });
      }

      rows.push(cardBox("horizontal", rowButtons, { margin: i > 0 ? "md" : undefined }));
    }

    bubble.footer = cardBox("vertical", rows, { paddingAll: "lg", backgroundColor: "#FAFAFA" });
  }

  return bubble;
}
