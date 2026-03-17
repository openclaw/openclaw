import {
  createActionCard,
  createImageCard,
  createInfoCard,
  createListCard,
  createReceiptCard
} from "openclaw/plugin-sdk/line";
const CARD_USAGE = `Usage: /card <type> "title" "body" [options]

Types:
  info "Title" "Body" ["Footer"]
  image "Title" "Caption" --url <image-url>
  action "Title" "Body" --actions "Btn1|url1,Btn2|text2"
  list "Title" "Item1|Desc1,Item2|Desc2"
  receipt "Title" "Item1:$10,Item2:$20" --total "$30"
  confirm "Question?" --yes "Yes|data" --no "No|data"
  buttons "Title" "Text" --actions "Btn1|url1,Btn2|data2"

Examples:
  /card info "Welcome" "Thanks for joining!"
  /card image "Product" "Check it out" --url https://example.com/img.jpg
  /card action "Menu" "Choose an option" --actions "Order|/order,Help|/help"`;
function buildLineReply(lineData) {
  return {
    channelData: {
      line: lineData
    }
  };
}
function parseActions(actionsStr) {
  if (!actionsStr) {
    return [];
  }
  const results = [];
  for (const part of actionsStr.split(",")) {
    const [label, data] = part.trim().split("|").map((s) => s.trim());
    if (!label) {
      continue;
    }
    const actionData = data || label;
    if (actionData.startsWith("http://") || actionData.startsWith("https://")) {
      results.push({
        label,
        action: { type: "uri", label: label.slice(0, 20), uri: actionData }
      });
    } else if (actionData.includes("=")) {
      results.push({
        label,
        action: {
          type: "postback",
          label: label.slice(0, 20),
          data: actionData.slice(0, 300),
          displayText: label
        }
      });
    } else {
      results.push({
        label,
        action: { type: "message", label: label.slice(0, 20), text: actionData }
      });
    }
  }
  return results;
}
function parseListItems(itemsStr) {
  return itemsStr.split(",").map((part) => {
    const [title, subtitle] = part.trim().split("|").map((s) => s.trim());
    return { title: title || "", subtitle };
  }).filter((item) => item.title);
}
function parseReceiptItems(itemsStr) {
  return itemsStr.split(",").map((part) => {
    const colonIndex = part.lastIndexOf(":");
    if (colonIndex === -1) {
      return { name: part.trim(), value: "" };
    }
    return {
      name: part.slice(0, colonIndex).trim(),
      value: part.slice(colonIndex + 1).trim()
    };
  }).filter((item) => item.name);
}
function parseCardArgs(argsStr) {
  const result = {
    type: "",
    args: [],
    flags: {}
  };
  const typeMatch = argsStr.match(/^(\w+)/);
  if (typeMatch) {
    result.type = typeMatch[1].toLowerCase();
    argsStr = argsStr.slice(typeMatch[0].length).trim();
  }
  const quotedRegex = /"([^"]*?)"/g;
  let match;
  while ((match = quotedRegex.exec(argsStr)) !== null) {
    result.args.push(match[1]);
  }
  const flagRegex = /--(\w+)\s+(?:"([^"]*?)"|(\S+))/g;
  while ((match = flagRegex.exec(argsStr)) !== null) {
    result.flags[match[1]] = match[2] ?? match[3];
  }
  return result;
}
function registerLineCardCommand(api) {
  api.registerCommand({
    name: "card",
    description: "Send a rich card message (LINE).",
    acceptsArgs: true,
    requireAuth: false,
    handler: async (ctx) => {
      const argsStr = ctx.args?.trim() ?? "";
      if (!argsStr) {
        return { text: CARD_USAGE };
      }
      const parsed = parseCardArgs(argsStr);
      const { type, args, flags } = parsed;
      if (!type) {
        return { text: CARD_USAGE };
      }
      if (ctx.channel !== "line") {
        const fallbackText = args.join(" - ");
        return { text: `[${type} card] ${fallbackText}`.trim() };
      }
      try {
        switch (type) {
          case "info": {
            const [title = "Info", body = "", footer] = args;
            const bubble = createInfoCard(title, body, footer);
            return buildLineReply({
              flexMessage: {
                altText: `${title}: ${body}`.slice(0, 400),
                contents: bubble
              }
            });
          }
          case "image": {
            const [title = "Image", caption = ""] = args;
            const imageUrl = flags.url || flags.image;
            if (!imageUrl) {
              return { text: "Error: Image card requires --url <image-url>" };
            }
            const bubble = createImageCard(imageUrl, title, caption);
            return buildLineReply({
              flexMessage: {
                altText: `${title}: ${caption}`.slice(0, 400),
                contents: bubble
              }
            });
          }
          case "action": {
            const [title = "Actions", body = ""] = args;
            const actions = parseActions(flags.actions);
            if (actions.length === 0) {
              return { text: 'Error: Action card requires --actions "Label1|data1,Label2|data2"' };
            }
            const bubble = createActionCard(title, body, actions, {
              imageUrl: flags.url || flags.image
            });
            return buildLineReply({
              flexMessage: {
                altText: `${title}: ${body}`.slice(0, 400),
                contents: bubble
              }
            });
          }
          case "list": {
            const [title = "List", itemsStr = ""] = args;
            const items = parseListItems(itemsStr || flags.items || "");
            if (items.length === 0) {
              return {
                text: 'Error: List card requires items. Usage: /card list "Title" "Item1|Desc1,Item2|Desc2"'
              };
            }
            const bubble = createListCard(title, items);
            return buildLineReply({
              flexMessage: {
                altText: `${title}: ${items.map((i) => i.title).join(", ")}`.slice(0, 400),
                contents: bubble
              }
            });
          }
          case "receipt": {
            const [title = "Receipt", itemsStr = ""] = args;
            const items = parseReceiptItems(itemsStr || flags.items || "");
            const total = flags.total ? { label: "Total", value: flags.total } : void 0;
            const footer = flags.footer;
            if (items.length === 0) {
              return {
                text: 'Error: Receipt card requires items. Usage: /card receipt "Title" "Item1:$10,Item2:$20" --total "$30"'
              };
            }
            const bubble = createReceiptCard({ title, items, total, footer });
            return buildLineReply({
              flexMessage: {
                altText: `${title}: ${items.map((i) => `${i.name} ${i.value}`).join(", ")}`.slice(
                  0,
                  400
                ),
                contents: bubble
              }
            });
          }
          case "confirm": {
            const [question = "Confirm?"] = args;
            const yesStr = flags.yes || "Yes|yes";
            const noStr = flags.no || "No|no";
            const [yesLabel, yesData] = yesStr.split("|").map((s) => s.trim());
            const [noLabel, noData] = noStr.split("|").map((s) => s.trim());
            return buildLineReply({
              templateMessage: {
                type: "confirm",
                text: question,
                confirmLabel: yesLabel || "Yes",
                confirmData: yesData || "yes",
                cancelLabel: noLabel || "No",
                cancelData: noData || "no",
                altText: question
              }
            });
          }
          case "buttons": {
            const [title = "Menu", text = "Choose an option"] = args;
            const actionsStr = flags.actions || "";
            const actionParts = parseActions(actionsStr);
            if (actionParts.length === 0) {
              return { text: 'Error: Buttons card requires --actions "Label1|data1,Label2|data2"' };
            }
            const templateActions = actionParts.map((a) => {
              const action = a.action;
              const label = action.label ?? a.label;
              if (action.type === "uri") {
                return { type: "uri", label, uri: action.uri };
              }
              if (action.type === "postback") {
                return {
                  type: "postback",
                  label,
                  data: action.data
                };
              }
              return {
                type: "message",
                label,
                data: action.text
              };
            });
            return buildLineReply({
              templateMessage: {
                type: "buttons",
                title,
                text,
                thumbnailImageUrl: flags.url || flags.image,
                actions: templateActions
              }
            });
          }
          default:
            return {
              text: `Unknown card type: "${type}". Available types: info, image, action, list, receipt, confirm, buttons`
            };
        }
      } catch (err) {
        return { text: `Error creating card: ${String(err)}` };
      }
    }
  });
}
export {
  registerLineCardCommand
};
