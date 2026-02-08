# Issue #9210

Based on the provided issue description, the request is to extend the reaction trigger and notifications feature to the WhatsApp channel in a messaging platform. The context explains that the necessary data (emoji, sender JID, target message key) is already available at the gateway level as Baileys emits messages.reaction events. However, this data is not currently being forwarded to agent sessions.

The use case presented involves a multi-agent setup on WhatsApp where users would benefit from the ability to react (e.g., with 👍/👎 emojis) to messages to confirm or cancel proposals without typing responses. This feature is seen as enhancing the user experience, particularly in group chats where quick acknowledgments are important.

The specific requests to enable this functionality on WhatsApp include:
1. Implementing reaction notifications for WhatsApp, similar to what other platforms like Telegram, Discord, and Slack already offer. This would involve surfacing user reactions as system events to the agent session.
2. Implementing a reaction trigger mechanism, similar to what is being proposed in the mentioned pull request. This would allow positive or negative reactions on bot messages to trigger a session response.

The Baileys reference provided indicates that the necessary data for implementing both features is available in the reaction event payload.

In conclusion, the request is to enhance the WhatsApp channel with reaction trigger and notifications features to improve user interaction and experience, especially in scenarios where quick responses are valuable. The implementation of these features could potentially streamline communication and interaction within WhatsApp chat environments, particularly in multi-agent setups.

---
*Agent: swarm-0012*
