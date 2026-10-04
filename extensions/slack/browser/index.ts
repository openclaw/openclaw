import { createSessionHeaderLink, defineControlUiPlugin } from "openclaw/plugin-sdk/control-ui";

export default defineControlUiPlugin({
  id: "slack",
  activate(host) {
    return host.ui.registerAccessory({
      id: "conversation-origin",
      placement: "session-header",
      mount: createSessionHeaderLink(({ conversationLink }) => {
        const url = conversationLink && URL.parse(conversationLink.url);
        // Slack's app_redirect destinations are HTTPS; persisted metadata must not weaken that contract.
        return url?.protocol === "https:" &&
          (url.hostname === "slack.com" ||
            url.hostname.endsWith(".slack.com") ||
            url.hostname === "slack-gov.com" ||
            url.hostname.endsWith(".slack-gov.com"))
          ? conversationLink
          : undefined;
      }),
    });
  },
});
