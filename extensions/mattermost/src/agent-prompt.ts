import type { ChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import { inspectMattermostAccount } from "./mattermost/accounts.js";

// Mattermost turns only plain `value` buttons into controls; typed actions stay text.
const BUTTONS_HINT =
  '- Inline buttons: `send` with `presentation={"blocks":[{"type":"buttons","buttons":[{"label":"Yes","value":"yes","style":"primary"}]}]}`. Typed `callback` actions render as plain text.';
const BUTTONS_OFF_HINT =
  '- Inline buttons OFF for mattermost; ask owner to add "inlineButtons" to mattermost.capabilities.';

export const mattermostAgentPrompt: NonNullable<ChannelPlugin["agentPrompt"]> = {
  messageToolHints: ({ cfg, accountId }) => {
    const capabilities = inspectMattermostAccount({ cfg, accountId }).config.capabilities;
    const inlineButtons = capabilities?.some(
      (entry) => entry.trim().toLowerCase() === "inlinebuttons",
    );
    return [inlineButtons ? BUTTONS_HINT : BUTTONS_OFF_HINT];
  },
};
